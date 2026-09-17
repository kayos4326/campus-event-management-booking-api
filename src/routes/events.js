const express = require("express");
const { prisma } = require("../services/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { sendSupplyRequest } = require("../services/merch");
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

// Cover images arrive as the raw file (no multipart wrapper, so no extra dependency) —
// only for these routes, and only for real image content types.
const imageBody = express.raw({ type: IMAGE_TYPES, limit: MAX_IMAGE_BYTES });

function isOwnerOrAdmin(req, event) {
  return req.user.role === "ADMIN" || event.organizerId === req.user.id;
}

// Students/public browse only published events (docs/proposal.md). ?mine=true (added
// for the frontend's "My Events" panel — not in the original proposal) lets an
// Organizer see their own events regardless of status, including drafts; Admins see
// everything via /admin/events instead.
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

// The only endpoint in the app that isn't behind a token: an <img> tag can't send an
// Authorization header. The unguessable key in the URL is what stands in for one — it's
// handed out with the event itself, which is already hidden from people who shouldn't
// see it (a draft is only ever returned to its organizer and Admins).
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
    // Safe to cache forever: replacing the image mints a new key, so the URL changes with it.
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    // Overrides helmet's global same-origin default. This URL is deliberately public —
    // the key in it is what grants access — and same-origin would block the image in
    // `npm run dev` and the e2e build, where the API isn't the page's own origin.
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    // Prisma hands `Bytes` back as a Uint8Array, and res.send() would JSON-encode that
    // into an array of numbers — served under an image content type, so it just looks
    // like a corrupt file. Buffer.from() is what makes it a binary response.
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

    // The event and its supply order are one write: either both exist or neither does.
    // Separately, a failed second insert left an event flagged as having supplies with no
    // order behind it, and a 500 that invited the organizer to create the event again.
    const { preorder, ...event } = await prisma.$transaction((tx) =>
      tx.event.create({
        data: {
          title,
          description,
          startsAt,
          endsAt,
          capacity,
          venueId: venue.id,
          organizerId: req.user.id,
          // The flag now just records "this event has a supply order attached".
          isLargeConference: Boolean(supply),
          status,
          ...(supply && { preorder: { create: { item: supply.item, quantity: supply.quantity, status: "PENDING" } } }),
        },
        include: { preorder: true },
      })
    );

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
      // Ordered only once the event is live — see services/merch.js.
      // Best-effort: a failed notification shouldn't block event creation.
      if (event.status === "PUBLISHED") sendSupplyRequest(event).catch(() => {});
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

      // A draft's supply order is sent when it's published (services/merch.js).
      if (result.status === "PUBLISHED" && event.status !== "PUBLISHED" && event.isLargeConference) {
        sendSupplyRequest(result).catch(() => {});
      }

      if (result.status === "CANCELLED" && event.status !== "CANCELLED") {
        await cancelActiveBookings(tx, event.id);
      } else if (result.status === "PUBLISHED") {
        // Covers a capacity increase, and a draft being re-published with a waitlist.
        await fillOpenSeats(tx, result);
      }
      return { result, before: event };
    });

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
