const express = require("express");
const { prisma } = require("../services/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/asyncHandler");
const { bookSeat, cancelBooking } = require("../services/bookings");
const { IMAGE_SELECT, withImageUrl } = require("../services/eventImages");
const { validate } = require("../validation/validate");
const schemas = require("../validation/schemas");

const router = express.Router();

// docs/proposal.md: RSVP reserves a seat, or joins the waitlist once the event is full.
// Seat logic (locking, rebooking after a cancel, waitlist promotion) lives in
// services/bookings.js.
router.post(
  "/",
  requireAuth,
  requireRole("STUDENT"),
  validate({ body: schemas.bookingCreate }),
  asyncHandler(async (req, res) => {
    let booking;
    try {
      booking = await bookSeat(req.valid.body.eventId, req.user.id);
    } catch (err) {
      // P2002: unique constraint on (eventId, studentId) — confirmed directly by
      // testing a duplicate booking; without this it surfaced as a generic 500. The
      // event lock makes this unlikely now, but it stays as a safety net.
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
      include: { event: { include: { venue: true, image: IMAGE_SELECT } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(bookings.map((booking) => ({ ...booking, event: withImageUrl(booking.event) })));
  })
);

// Cancelling a CONFIRMED booking hands the seat to the oldest WAITLISTED booking.
router.patch(
  "/:id/cancel",
  requireAuth,
  requireRole("STUDENT"),
  validate({ params: schemas.idParams }),
  asyncHandler(async (req, res) => {
    const cancelled = await cancelBooking(req.valid.params.id, req.user.id);
    res.json(cancelled);
  })
);

module.exports = router;
