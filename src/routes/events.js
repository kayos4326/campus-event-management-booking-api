const express = require("express");
const { prisma } = require("../services/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { createSupplyRequest, sendSupplyRequest } = require("../services/merch");
const { asyncHandler } = require("../middleware/asyncHandler");
const {
  withEventTransaction,
  lockEvent,
  fillOpenSeats,
  cancelActiveBookings,
  withSeatCounts,
} = require("../services/bookings");
const { HttpError, parseId } = require("../utils/http");
const {
  MAX_IMAGE_BYTES,
  IMAGE_TYPES,
  IMAGE_SELECT,
  detectImageType,
  newImageKey,
  imageUrl,
  withImageUrl,
} = require("../services/eventImages");
const audit = require("../services/audit");

const router = express.Router();

// Cover images arrive as the raw file (no multipart wrapper, so no extra dependency) —
// only for these routes, and only for real image content types.
const imageBody = express.raw({ type: IMAGE_TYPES, limit: MAX_IMAGE_BYTES });

const EVENT_STATUSES = ["DRAFT", "PUBLISHED", "CANCELLED"];
const MAX_SUPPLY_QUANTITY = 100000;

// An optional supply order attached to an event: what to order and how many. Quantity
// defaults to one per seat. Returns null when the organizer didn't ask for anything, or
// an { error } for the route to return as a 400.
function parseSupplyRequest(supply, capacity) {
  if (supply === undefined || supply === null || supply === "") return { supply: null };

  const item = typeof supply.item === "string" ? supply.item.trim() : "";
  if (!item) return { error: "Say what to order (for example: Blank lanyards)" };
  if (item.length > 100) return { error: "Keep the supply item under 100 characters" };

  if (supply.quantity === undefined || supply.quantity === null || supply.quantity === "") {
    return { supply: { item, quantity: capacity } };
  }
  const quantity = Number(supply.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_SUPPLY_QUANTITY) {
    return { error: `How many? Use a whole number between 1 and ${MAX_SUPPLY_QUANTITY}` };
  }
  return { supply: { item, quantity } };
}

function isOwnerOrAdmin(req, event) {
  return req.user.role === "ADMIN" || event.organizerId === req.user.id;
}

// `new Date("garbage")` doesn't throw, it's an Invalid Date that Prisma then rejects
// with a generic 500 — checked up front so the caller gets a clear 400 instead.
function parseDate(value, label) {
  const date = new Date(value);
  if ((typeof value !== "string" && typeof value !== "number") || Number.isNaN(date.getTime())) {
    throw new HttpError(400, `${label} must be a valid date`);
  }
  return date;
}

// Students/public browse only published events (docs/proposal.md). ?mine=true (added
// for the frontend's "My Events" panel — not in the original proposal) lets an
// Organizer see their own events regardless of status, including drafts; Admins see
// everything via /admin/events instead.
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const where =
      req.query.mine === "true"
        ? { organizerId: req.user.id }
        : { status: "PUBLISHED" };

    const events = await prisma.event.findMany({
      where,
      // Organizers see the supply order they attached; the public browse view doesn't need it.
      include: { venue: true, image: IMAGE_SELECT, ...(req.query.mine === "true" && { preorder: true }) },
      orderBy: { startsAt: "asc" },
    });
    res.json((await withSeatCounts(events)).map(withImageUrl));
  })
);

router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const event = await prisma.event.findUnique({
      where: { id: parseId(req.params.id) },
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
  asyncHandler(async (req, res) => {
    const image = await prisma.eventImage.findUnique({ where: { key: String(req.params.key) } });
    if (!image || image.eventId !== parseId(req.params.id)) {
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

router.get(
  "/:id/bookings",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const event = await prisma.event.findUnique({ where: { id: parseId(req.params.id) } });
    if (!event) return res.status(404).json({ error: "Event not found" });
    if (!isOwnerOrAdmin(req, event)) {
      return res.status(403).json({ error: "You can only view your own events" });
    }

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
  asyncHandler(async (req, res) => {
    const event = await prisma.event.findUnique({ where: { id: parseId(req.params.id) } });
    if (!event) return res.status(404).json({ error: "Event not found" });
    if (!isOwnerOrAdmin(req, event)) {
      return res.status(403).json({ error: "You can only view your own events" });
    }

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
  asyncHandler(async (req, res) => {
    const { title, description, startsAt, endsAt, capacity, venueId, supply, status } = req.body;
    // `!capacity` would wrongly reject a legitimate capacity of 0 as "missing" (0 is
    // falsy) — confirmed directly by testing. Checked explicitly instead.
    if (!title || !startsAt || !endsAt || venueId === undefined) {
      return res.status(400).json({ error: "Missing required event fields" });
    }
    if (!Number.isInteger(capacity) || capacity < 1) {
      return res.status(400).json({ error: "Capacity must be a whole number of at least 1" });
    }
    const start = parseDate(startsAt, "Start time");
    const end = parseDate(endsAt, "End time");
    if (end <= start) {
      return res.status(400).json({ error: "The event must end after it starts" });
    }
    if (status !== undefined && status !== "DRAFT" && status !== "PUBLISHED") {
      return res.status(400).json({ error: "status must be DRAFT or PUBLISHED" });
    }
    const { supply: supplyRequest, error: supplyError } = parseSupplyRequest(supply, capacity);
    if (supplyError) return res.status(400).json({ error: supplyError });

    const venue = Number.isInteger(Number(venueId))
      ? await prisma.venue.findUnique({ where: { id: Number(venueId) } })
      : null;
    if (!venue) {
      return res.status(400).json({ error: "That venue doesn't exist" });
    }

    const event = await prisma.event.create({
      data: {
        title,
        description,
        startsAt: start,
        endsAt: end,
        capacity,
        venueId: venue.id,
        organizerId: req.user.id,
        // The flag now just records "this event has a supply order attached".
        isLargeConference: Boolean(supplyRequest),
        status: status === "PUBLISHED" ? "PUBLISHED" : "DRAFT",
      },
    });

    await audit.record(req.user, {
      action: "event.created",
      entityType: "event",
      entityId: event.id,
      summary: `Created "${event.title}" (${event.capacity} seats, ${String(event.status).toLowerCase()})`,
    });

    if (supplyRequest) {
      await createSupplyRequest(event.id, supplyRequest);
      await audit.record(req.user, {
        action: "event.supplies_requested",
        entityType: "event",
        entityId: event.id,
        summary: `Ordered ${supplyRequest.quantity} × ${supplyRequest.item} for "${event.title}"`,
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
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const { title, description, startsAt, endsAt, capacity, status } = req.body;

    if (title !== undefined && (typeof title !== "string" || !title.trim())) {
      return res.status(400).json({ error: "Title can't be empty" });
    }
    if (capacity !== undefined && (!Number.isInteger(capacity) || capacity < 1)) {
      return res.status(400).json({ error: "Capacity must be a whole number of at least 1" });
    }
    if (status !== undefined && !EVENT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${EVENT_STATUSES.join(", ")}` });
    }
    const newStart = startsAt !== undefined ? parseDate(startsAt, "Start time") : undefined;
    const newEnd = endsAt !== undefined ? parseDate(endsAt, "End time") : undefined;

    const updated = await withEventTransaction(async (tx) => {
      await lockEvent(tx, id);
      const event = await tx.event.findUnique({ where: { id } });
      if (!event) throw new HttpError(404, "Event not found");
      if (!isOwnerOrAdmin(req, event)) {
        throw new HttpError(403, "You can only manage your own events");
      }

      const start = newStart ?? event.startsAt;
      const end = newEnd ?? event.endsAt;
      if (start && end && end <= start) {
        throw new HttpError(400, "The event must end after it starts");
      }

      // Lowering capacity never bumps a confirmed student back to the waitlist.
      if (capacity !== undefined && capacity < event.capacity) {
        const confirmed = await tx.booking.count({ where: { eventId: id, status: "CONFIRMED" } });
        if (capacity < confirmed) {
          throw new HttpError(
            409,
            `Capacity can't be lower than the ${confirmed} seats already confirmed`
          );
        }
      }

      const result = await tx.event.update({
        where: { id: event.id },
        data: {
          ...(title !== undefined && { title }),
          ...(description !== undefined && { description }),
          ...(newStart !== undefined && { startsAt: newStart }),
          ...(newEnd !== undefined && { endsAt: newEnd }),
          ...(capacity !== undefined && { capacity }),
          ...(status !== undefined && { status }),
        },
      });

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

    const changes = audit.describeChanges(updated.before, req.body);
    if (changes) {
      await audit.record(req.user, {
        action: updated.result.status === "CANCELLED" ? "event.cancelled" : "event.updated",
        entityType: "event",
        entityId: updated.result.id,
        summary: `${updated.result.status === "CANCELLED" ? "Cancelled" : "Updated"} "${updated.result.title}": ${changes}`,
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
  imageBody,
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const event = await prisma.event.findUnique({ where: { id } });
    if (!event) return res.status(404).json({ error: "Event not found" });
    if (!isOwnerOrAdmin(req, event)) {
      return res.status(403).json({ error: "You can only manage your own events" });
    }

    const mimeType = detectImageType(req.body);
    if (!mimeType) {
      return res.status(400).json({ error: "That file isn't a JPEG, PNG or WebP image" });
    }

    const key = newImageKey();
    await prisma.eventImage.upsert({
      where: { eventId: id },
      create: { eventId: id, key, mimeType, bytes: req.body },
      update: { key, mimeType, bytes: req.body },
    });
    await audit.record(req.user, {
      action: "event.image_updated",
      entityType: "event",
      entityId: id,
      summary: `Set a cover image for "${event.title}"`,
    });
    res.status(201).json({ imageUrl: imageUrl(id, key) });
  })
);

router.delete(
  "/:id/image",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const event = await prisma.event.findUnique({ where: { id } });
    if (!event) return res.status(404).json({ error: "Event not found" });
    if (!isOwnerOrAdmin(req, event)) {
      return res.status(403).json({ error: "You can only manage your own events" });
    }

    // deleteMany, not delete: removing an image that was never there is a no-op, not a 404.
    const { count } = await prisma.eventImage.deleteMany({ where: { eventId: id } });
    if (count) {
      await audit.record(req.user, {
        action: "event.image_removed",
        entityType: "event",
        entityId: id,
        summary: `Removed the cover image from "${event.title}"`,
      });
    }
    res.json({ id, imageUrl: null });
  })
);

router.delete(
  "/:id",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);

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
