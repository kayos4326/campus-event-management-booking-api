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

// Cover images are uploaded as the request body.
const imageBody = express.raw({ type: IMAGE_TYPES, limit: MAX_IMAGE_BYTES });

function isOwnerOrAdmin(req, event) {
  return req.user.role === "ADMIN" || event.organizerId === req.user.id;
}

// `mine=true` also includes the organizer's drafts and cancelled events.
router.get(
  "/",
  requireAuth,
  validate({ query: schemas.eventList }),
  asyncHandler(async (req, res) => {
    const { mine } = req.valid.query;
    const events = await prisma.event.findMany({
      where: mine ? { organizerId: req.user.id } : { status: "PUBLISHED" },
      // Supply details are only needed on the organizer page.
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
    // Hide drafts from everyone except their organizer and admins.
    if (!event || (event.status === "DRAFT" && !isOwnerOrAdmin(req, event))) {
      return res.status(404).json({ error: "Event not found" });
    }
    res.json(withImageUrl(event));
  })
);

// Browser image tags cannot attach the user's access token.
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
    // A replacement gets a new key, so this URL can be cached.
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    res.send(Buffer.from(image.bytes));
  })
);

// Find an event and check that this user can manage it.
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

// Show the latest changes made to one event.
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

    // Save the event and supply job in one transaction.
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
          // Kept for compatibility with the original schema.
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
      // Ask the worker to check the new job now.
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

      // Use the saved date when only one date was edited.
      const start = changes.startsAt ?? event.startsAt;
      const end = changes.endsAt ?? event.endsAt;
      if (start && end && end <= start) {
        throw new HttpError(400, "The event must end after it starts");
      }

      // Do not remove seats that are already confirmed.
      if (changes.capacity !== undefined && changes.capacity < event.capacity) {
        const confirmed = await tx.booking.count({ where: { eventId: id, status: "CONFIRMED" } });
        if (changes.capacity < confirmed) {
          throw new HttpError(
            409,
            `Capacity can't be lower than the ${confirmed} seats already confirmed`
          );
        }
      }

      const result = await tx.event.update({ where: { id: event.id }, data: changes });

      // Queue a draft's supply request when the event is published.
      let supplyQueued = null;
      if (result.status === "PUBLISHED" && event.status !== "PUBLISHED" && event.isLargeConference) {
        const preorder = await tx.merchPreorder.findUnique({ where: { eventId: event.id } });
        supplyQueued = await enqueueSupplyRequest(tx, preorder);
      }

      if (result.status === "CANCELLED" && event.status !== "CANCELLED") {
        await cancelActiveBookings(tx, event.id);
      } else if (result.status === "PUBLISHED") {
        // A larger capacity may open seats for the waitlist.
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

// Upload the image without a multipart form wrapper.
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

    // Missing images are treated as already removed.
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
      // Cancel its active bookings too.
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
