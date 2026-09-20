const express = require("express");
const { prisma } = require("../services/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { enqueueSupplyRequest } = require("../services/merch");
const outbox = require("../services/outbox");
const { asyncHandler } = require("../middleware/asyncHandler");
const {
  withEventTransaction,
  lockEvent,
  fillOpenSeats,
  cancelActiveBookings,
  withSeatCounts,
} = require("../services/bookings");
const { HttpError } = require("../utils/http");
const {
  MAX_IMAGE_BYTES,
  IMAGE_TYPES,
  IMAGE_SELECT,
  detectImageType,
  newImageKey,
  imageUrl,
  withImageUrl,
} = require("../services/eventImages");
const { validate } = require("../validation/validate");
const schemas = require("../validation/schemas");
const audit = require("../services/audit");

const router = express.Router();

// Cover-image routes receive the raw image body instead of multipart form data.
const imageBody = express.raw({ type: IMAGE_TYPES, limit: MAX_IMAGE_BYTES });

function isOwnerOrAdmin(req, event) {
  return req.user.role === "ADMIN" || event.organizerId === req.user.id;
}

// Browse returns published events; `mine=true` returns every status owned by the caller.
router.get(
  "/",
  requireAuth,
  validate({ query: schemas.eventList }),
  asyncHandler(async (req, res) => {
    const { mine } = req.valid.query;
    const events = await prisma.event.findMany({
      where: mine ? { organizerId: req.user.id } : { status: "PUBLISHED" },
      // Organizers see the supply order they attached; the public browse view doesn't need it.
      include: { venue: true, image: IMAGE_SELECT, ...(mine && { preorder: true }) },
      orderBy: { startsAt: "asc" },
    });
    res.json((await withSeatCounts(events)).map(withImageUrl));
  })
);

router.get(
  "/:id",
  requireAuth,
  validate({ params: schemas.idParams }),
  asyncHandler(async (req, res) => {
    const event = await prisma.event.findUnique({
      where: { id: req.valid.params.id },
      include: { venue: true, image: IMAGE_SELECT },
    });
    // Drafts are only visible to their organizer and Admins — same 404 as a missing
    // event, so a draft's existence doesn't leak.
    if (!event || (event.status === "DRAFT" && !isOwnerOrAdmin(req, event))) {
      return res.status(404).json({ error: "Event not found" });
    }
    res.json(withImageUrl(event));
  })
);

// Image tags cannot send bearer tokens, so an unguessable image key grants read access.
router.get(
  "/:id/image/:key",
  validate({ params: schemas.imageParams }),
  asyncHandler(async (req, res) => {
    const { id, key } = req.valid.params;
    const image = await prisma.eventImage.findUnique({ where: { key } });
    if (!image || image.eventId !== id) {
      return res.status(404).json({ error: "Image not found" });
    }
    res.set("Content-Type", image.mimeType);
    // Replacing an image creates a new key, making immutable caching safe.
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    // Allow the image in local frontend development where UI and API origins differ.
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    // Convert Prisma's Uint8Array to an actual binary HTTP body.
    res.send(Buffer.from(image.bytes));
  })
);

// Loads an event the caller manages (owner or Admin), or answers 404/403 for them.
async function findManagedEvent(req, res, forbidden = "You can only view your own events") {
  const event = await prisma.event.findUnique({ where: { id: req.valid.params.id } });
  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return null;
  }
  if (!isOwnerOrAdmin(req, event)) {
    res.status(403).json({ error: forbidden });
    return null;
  }
  return event;
}

router.get(
  "/:id/bookings",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  validate({ params: schemas.idParams }),
  asyncHandler(async (req, res) => {
    const event = await findManagedEvent(req, res);
    if (!event) return;

    const bookings = await prisma.booking.findMany({
      where: { eventId: event.id },
      include: { student: { select: { id: true, displayName: true, email: true } } },
    });
    res.json(bookings);
  })
);

// Everything that happened to one event — who created, edited, published or cancelled it.
router.get(
  "/:id/history",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  validate({ params: schemas.idParams }),
  asyncHandler(async (req, res) => {
    const event = await findManagedEvent(req, res);
    if (!event) return;

    const history = await prisma.auditLog.findMany({
      where: { entityType: "event", entityId: event.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json(history);
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  validate({ body: schemas.eventCreate }),
  asyncHandler(async (req, res) => {
    const { title, description, startsAt, endsAt, capacity, venueId, status, supply } = req.valid.body;

    const venue = await prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) {
      return res.status(400).json({ error: "That venue doesn't exist" });
    }

    // Event, supply request and delivery job succeed or roll back together.
    const { preorder, ...event } = await prisma.$transaction(async (tx) => {
      const created = await tx.event.create({
        data: {
          title,
          description,
          startsAt,
          endsAt,
          capacity,
          venueId: venue.id,
          organizerId: req.user.id,
          // This compatibility flag records that a supply request is attached.
          isLargeConference: Boolean(supply),
          status,
          ...(supply && { preorder: { create: { item: supply.item, quantity: supply.quantity, status: "PENDING" } } }),
        },
        include: { preorder: true },
      });
      if (created.status === "PUBLISHED") await enqueueSupplyRequest(tx, created.preorder);
      return created;
    });

    await audit.record(req.user, {
      action: "event.created",
      entityType: "event",
      entityId: event.id,
      summary: `Created "${event.title}" (${event.capacity} seats, ${String(event.status).toLowerCase()})`,
    });

    if (preorder) {
      await audit.record(req.user, {
        action: "event.supplies_requested",
        entityType: "event",
        entityId: event.id,
        summary: `Ordered ${supply.quantity} × ${supply.item} for "${event.title}"`,
      });
      // Committed above; this just saves waiting for the worker's next poll.
      if (event.status === "PUBLISHED") outbox.kick();
    }

    res.status(201).json(event);
  })
);

router.patch(
  "/:id",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  validate({ params: schemas.idParams, body: schemas.eventUpdate }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    const changes = req.valid.body;

    const updated = await withEventTransaction(async (tx) => {
      await lockEvent(tx, id);
      const event = await tx.event.findUnique({ where: { id } });
      if (!event) throw new HttpError(404, "Event not found");
      if (!isOwnerOrAdmin(req, event)) {
        throw new HttpError(403, "You can only manage your own events");
      }

      // Only one of the two dates may be changing, so compare against the stored one.
      const start = changes.startsAt ?? event.startsAt;
      const end = changes.endsAt ?? event.endsAt;
      if (start && end && end <= start) {
        throw new HttpError(400, "The event must end after it starts");
      }

      // Lowering capacity never bumps a confirmed student back to the waitlist.
      if (changes.capacity !== undefined && changes.capacity < event.capacity) {
        const confirmed = await tx.booking.count({ where: { eventId: id, status: "CONFIRMED" } });
        if (changes.capacity < confirmed) {
          throw new HttpError(
            409,
            `Capacity can't be lower than the ${confirmed} seats already confirmed`
          );
        }
      }

      // Every key in `changes` came through the schema, so none is ever `organizerId` etc.
      const result = await tx.event.update({ where: { id: event.id }, data: changes });

      // A draft's supply order is sent when it's published — queued here, in the same
      // transaction as the publish, and delivered by the outbox worker (services/outbox.js).
      let supplyQueued = null;
      if (result.status === "PUBLISHED" && event.status !== "PUBLISHED" && event.isLargeConference) {
        const preorder = await tx.merchPreorder.findUnique({ where: { eventId: event.id } });
        supplyQueued = await enqueueSupplyRequest(tx, preorder);
      }

      if (result.status === "CANCELLED" && event.status !== "CANCELLED") {
        await cancelActiveBookings(tx, event.id);
      } else if (result.status === "PUBLISHED") {
        // Covers a capacity increase, and a draft being re-published with a waitlist.
        await fillOpenSeats(tx, result);
      }
      return { result, before: event, supplyQueued };
    });
    if (updated.supplyQueued) outbox.kick();

    const summary = audit.describeChanges(updated.before, changes);
    if (summary) {
      await audit.record(req.user, {
        action: updated.result.status === "CANCELLED" ? "event.cancelled" : "event.updated",
        entityType: "event",
        entityId: updated.result.id,
        summary: `${updated.result.status === "CANCELLED" ? "Cancelled" : "Updated"} "${updated.result.title}": ${summary}`,
      });
    }
    res.json(updated.result);
  })
);

// The raw file is the whole request body — `Content-Type: image/jpeg`, no form wrapper.
router.post(
  "/:id/image",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  validate({ params: schemas.idParams }),
  imageBody,
  asyncHandler(async (req, res) => {
    const event = await findManagedEvent(req, res, "You can only manage your own events");
    if (!event) return;

    const mimeType = detectImageType(req.body);
    if (!mimeType) {
      return res.status(400).json({ error: "That file isn't a JPEG, PNG or WebP image" });
    }

    const key = newImageKey();
    await prisma.eventImage.upsert({
      where: { eventId: event.id },
      create: { eventId: event.id, key, mimeType, bytes: req.body },
      update: { key, mimeType, bytes: req.body },
    });
    await audit.record(req.user, {
      action: "event.image_updated",
      entityType: "event",
      entityId: event.id,
      summary: `Set a cover image for "${event.title}"`,
    });
    res.status(201).json({ imageUrl: imageUrl(event.id, key) });
  })
);

router.delete(
  "/:id/image",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  validate({ params: schemas.idParams }),
  asyncHandler(async (req, res) => {
    const event = await findManagedEvent(req, res, "You can only manage your own events");
    if (!event) return;

    // deleteMany, not delete: removing an image that was never there is a no-op, not a 404.
    const { count } = await prisma.eventImage.deleteMany({ where: { eventId: event.id } });
    if (count) {
      await audit.record(req.user, {
        action: "event.image_removed",
        entityType: "event",
        entityId: event.id,
        summary: `Removed the cover image from "${event.title}"`,
      });
    }
    res.json({ id: event.id, imageUrl: null });
  })
);

router.delete(
  "/:id",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  validate({ params: schemas.idParams }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;

    const cancelled = await withEventTransaction(async (tx) => {
      await lockEvent(tx, id);
      const event = await tx.event.findUnique({ where: { id } });
      if (!event) throw new HttpError(404, "Event not found");
      if (!isOwnerOrAdmin(req, event)) {
        throw new HttpError(403, "You can only manage your own events");
      }

      const result = await tx.event.update({
        where: { id: event.id },
        data: { status: "CANCELLED" },
      });
      // A cancelled event has no seats to hold — its bookings are cancelled with it.
      const active = await tx.booking.count({ where: { eventId: event.id, status: { in: ["CONFIRMED", "WAITLISTED"] } } });
      await cancelActiveBookings(tx, event.id);
      return { result, active };
    });

    await audit.record(req.user, {
      action: "event.cancelled",
      entityType: "event",
      entityId: cancelled.result.id,
      summary: `Cancelled "${cancelled.result.title}"${cancelled.active ? `, releasing ${cancelled.active} booking(s)` : ""}`,
    });
    res.json(cancelled.result);
  })
);

module.exports = router;
