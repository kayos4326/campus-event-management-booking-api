const express = require("express");
const { prisma } = require("../services/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

router.post("/", requireAuth, requireRole("STUDENT"), async (req, res) => {
  const { eventId } = req.body;
  if (!eventId) return res.status(400).json({ error: "eventId is required" });

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: { _count: { select: { bookings: true } } },
  });
  if (!event) return res.status(404).json({ error: "Event not found" });
  if (event._count.bookings >= event.capacity) {
    return res.status(409).json({ error: "Event is at capacity" });
  }

  const booking = await prisma.booking.create({
    data: { eventId, userId: req.user.sub },
  });
  res.status(201).json(booking);
});

router.get("/mine", requireAuth, requireRole("STUDENT"), async (req, res) => {
  const bookings = await prisma.booking.findMany({
    where: { userId: req.user.sub },
    include: { event: true },
  });
  res.json(bookings);
});

module.exports = router;
