const express = require("express");
const { prisma } = require("../services/prisma");
const { requirePeerApiKey } = require("../middleware/apiKey");
const { asyncHandler } = require("../middleware/asyncHandler");
const { validate } = require("../validation/validate");
const schemas = require("../validation/schemas");

const router = express.Router();

// Read-only integration endpoint protected by an Admin-issued API key.
// GET /events/api/peer/events/active?room=<number>
router.get(
  "/events/active",
  requirePeerApiKey("room-status:read"),
  validate({ query: schemas.roomQuery }),
  asyncHandler(async (req, res) => {
    const { room } = req.valid.query;

    const now = new Date();
    const event = await prisma.event.findFirst({
      where: {
        status: "PUBLISHED",
        startsAt: { lte: now },
        endsAt: { gte: now },
        venue: { roomNumber: room },
      },
    });

    if (!event) {
      return res.json({ active: false });
    }

    res.json({
      active: true,
      eventId: event.id,
      title: event.title,
      endsAt: event.endsAt,
    });
  })
);

module.exports = router;
