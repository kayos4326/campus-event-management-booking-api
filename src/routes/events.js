const express = require("express");
const { prisma } = require("../services/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { preorderLanyards } = require("../services/merch");

const router = express.Router();

function isOwnerOrAdmin(req, event) {
  return req.user.role === "ADMIN" || event.organizerId === req.user.id;
}

// Students/public browse only published events (docs/proposal.md); organizers/admins
// see everything of their own via the routes below and /admin.
router.get("/", requireAuth, async (req, res) => {
  const events = await prisma.event.findMany({
    where: { status: "PUBLISHED" },
    include: { venue: true },
  });
  res.json(events);
});

router.get("/:id", requireAuth, async (req, res) => {
  const event = await prisma.event.findUnique({
    where: { id: Number(req.params.id) },
    include: { venue: true },
  });
  if (!event) return res.status(404).json({ error: "Event not found" });
  res.json(event);
});

router.get("/:id/bookings", requireAuth, requireRole("ORGANIZER", "ADMIN"), async (req, res) => {
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
});

router.post("/", requireAuth, requireRole("ORGANIZER", "ADMIN"), async (req, res) => {
  const { title, description, startsAt, endsAt, capacity, venueId, isLargeConference, status } =
    req.body;
  if (!title || !startsAt || !endsAt || !capacity || !venueId) {
    return res.status(400).json({ error: "Missing required event fields" });
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
});

router.patch("/:id", requireAuth, requireRole("ORGANIZER", "ADMIN"), async (req, res) => {
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
});

router.delete("/:id", requireAuth, requireRole("ORGANIZER", "ADMIN"), async (req, res) => {
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
});

module.exports = router;
