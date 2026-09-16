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

const router = express.Router();

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
      include: { venue: true, ...(req.query.mine === "true" && { preorder: true }) },
      orderBy: { startsAt: "asc" },
    });
    res.json(await withSeatCounts(events));
  })
);

router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const event = await prisma.event.findUnique({
      where: { id: parseId(req.params.id) },
      include: { venue: true },
    });
    // Drafts are only visible to their organizer and Admins — same 404 as a missing
    // event, so a draft's existence doesn't leak.
    if (!event || (event.status === "DRAFT" && !isOwnerOrAdmin(req, event))) {
      return res.status(404).json({ error: "Event not found" });
    }
    res.json(event);
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

    if (supplyRequest) {
      await createSupplyRequest(event.id, supplyRequest);
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
      return result;
    });
    res.json(updated);
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
      await cancelActiveBookings(tx, event.id);
      return result;
    });
    res.json(cancelled);
  })
);

module.exports = router;
