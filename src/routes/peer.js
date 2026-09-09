const express = require("express");
const { prisma } = require("../services/prisma");
const { requirePeerApiKey } = require("../middleware/apiKey");

const router = express.Router();

// Exposed to the HelpDesk team (docs/proposal.md) so they can tell whether a broken-
// projector ticket for a room affects an event happening right now.
// GET /events/api/peer/events/active?room=<number>
router.get("/events/active", requirePeerApiKey("room-status:read"), async (req, res) => {
  const room = req.query.room;
  if (!room) {
    return res.status(400).json({ error: "room query param is required" });
  }

  const now = new Date();
  const event = await prisma.event.findFirst({
    where: {
      status: "PUBLISHED",
      startsAt: { lte: now },
      endsAt: { gte: now },
      venue: { roomNumber: String(room) },
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
});

module.exports = router;
