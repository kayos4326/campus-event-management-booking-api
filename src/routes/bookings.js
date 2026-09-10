const express = require("express");
const { prisma } = require("../services/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();

// docs/proposal.md: RSVP reserves a seat, or joins the waitlist once the event is full.
router.post(
  "/",
  requireAuth,
  requireRole("STUDENT"),
  asyncHandler(async (req, res) => {
    const { eventId } = req.body;
    if (!eventId) return res.status(400).json({ error: "eventId is required" });

    const event = await prisma.event.findUnique({
      where: { id: Number(eventId) },
      include: { _count: { select: { bookings: { where: { status: "CONFIRMED" } } } } },
    });
    if (!event || event.status !== "PUBLISHED") {
      return res.status(404).json({ error: "Event not found" });
    }

    const status = event._count.bookings >= event.capacity ? "WAITLISTED" : "CONFIRMED";

    let booking;
    try {
      booking = await prisma.booking.create({
        data: { eventId: event.id, studentId: req.user.id, status },
      });
    } catch (err) {
      // P2002: unique constraint on (eventId, studentId) — confirmed directly by
      // testing a duplicate booking; without this it surfaced as a generic 500.
      if (err.code === "P2002") {
        return res.status(409).json({ error: "You have already booked this event" });
      }
      throw err;
    }
    res.status(201).json(booking);
  })
);

router.get(
  "/mine",
  requireAuth,
  requireRole("STUDENT"),
  asyncHandler(async (req, res) => {
    const bookings = await prisma.booking.findMany({
      where: { studentId: req.user.id },
      include: { event: true },
    });
    res.json(bookings);
  })
);

router.patch(
  "/:id/cancel",
  requireAuth,
  requireRole("STUDENT"),
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.findUnique({ where: { id: Number(req.params.id) } });
    if (!booking || booking.studentId !== req.user.id) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const cancelled = await prisma.booking.update({
      where: { id: booking.id },
      data: { status: "CANCELLED" },
    });
    res.json(cancelled);
  })
);

module.exports = router;
