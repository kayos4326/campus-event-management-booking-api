const express = require("express");
const { prisma } = require("../services/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { preorderLanyards } = require("../services/merch");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();

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
  asyncHandler(async (req, res) => {
    const where =
      req.query.mine === "true"
        ? { organizerId: req.user.id }
        : { status: "PUBLISHED" };

    const events = await prisma.event.findMany({
      where,
      include: { venue: true },
    });
    res.json(events);
  })
);

router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const event = await prisma.event.findUnique({
      where: { id: Number(req.params.id) },
      include: { venue: true },
    });
    if (!event) return res.status(404).json({ error: "Event not found" });
    res.json(event);
  })
);

router.get(
  "/:id/bookings",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const event = await prisma.event.findUnique({ where: { id: Number(req.params.id) } });
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
    const { title, description, startsAt, endsAt, capacity, venueId, isLargeConference, status } =
      req.body;
    // `!capacity` would wrongly reject a legitimate capacity of 0 as "missing" (0 is
    // falsy) — confirmed directly by testing. Checked explicitly instead.
    if (!title || !startsAt || !endsAt || venueId === undefined) {
      return res.status(400).json({ error: "Missing required event fields" });
    }
    if (!Number.isInteger(capacity) || capacity < 1) {
      return res.status(400).json({ error: "capacity must be a positive integer" });
    }

    const event = await prisma.event.create({
      data: {
        title,
        description,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        capacity,
        venueId,
        organizerId: req.user.id,
        isLargeConference: Boolean(isLargeConference),
        status: status === "PUBLISHED" ? "PUBLISHED" : "DRAFT",
      },
    });

    if (event.isLargeConference) {
      // Best-effort — a failed notification shouldn't block event creation.
      preorderLanyards(event).catch(() => {});
    }

    res.status(201).json(event);
  })
);

router.patch(
  "/:id",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const event = await prisma.event.findUnique({ where: { id: Number(req.params.id) } });
    if (!event) return res.status(404).json({ error: "Event not found" });
    if (!isOwnerOrAdmin(req, event)) {
      return res.status(403).json({ error: "You can only manage your own events" });
    }

    const { title, description, startsAt, endsAt, capacity, status } = req.body;
    const updated = await prisma.event.update({
      where: { id: event.id },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(startsAt !== undefined && { startsAt: new Date(startsAt) }),
        ...(endsAt !== undefined && { endsAt: new Date(endsAt) }),
        ...(capacity !== undefined && { capacity }),
        ...(status !== undefined && { status }),
      },
    });
    res.json(updated);
  })
);

router.delete(
  "/:id",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const event = await prisma.event.findUnique({ where: { id: Number(req.params.id) } });
    if (!event) return res.status(404).json({ error: "Event not found" });
    if (!isOwnerOrAdmin(req, event)) {
      return res.status(403).json({ error: "You can only manage your own events" });
    }

    const cancelled = await prisma.event.update({
      where: { id: event.id },
      data: { status: "CANCELLED" },
    });
    res.json(cancelled);
  })
);

module.exports = router;
