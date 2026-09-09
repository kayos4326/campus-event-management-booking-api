const express = require("express");
const { prisma } = require("../services/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const events = await prisma.event.findMany({ include: { venue: true } });
  res.json(events);
});

router.get("/:id", requireAuth, async (req, res) => {
  const event = await prisma.event.findUnique({
    where: { id: req.params.id },
    include: { venue: true },
  });
  if (!event) return res.status(404).json({ error: "Event not found" });
  res.json(event);
});

router.post("/", requireAuth, requireRole("ORGANIZER"), async (req, res) => {
  const { title, description, category, startsAt, endsAt, capacity, venueId } = req.body;
  if (!title || !startsAt || !endsAt || !capacity || !venueId) {
    return res.status(400).json({ error: "Missing required event fields" });
  }

  const event = await prisma.event.create({
    data: {
      title,
      description,
      category,
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
      capacity,
      venueId,
      organizerId: req.user.sub,
    },
  });

  // TODO: if category === "tech_conference" and capacity is large, call the Merch
  // peer API to pre-order 50 blank lanyards (CLAUDE.md §5) — endpoint not finalized yet.

  res.status(201).json(event);
});

module.exports = router;
