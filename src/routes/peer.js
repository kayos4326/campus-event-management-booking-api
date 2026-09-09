const express = require("express");
const { prisma } = require("../services/prisma");
const { requirePeerApiKey } = require("../middleware/apiKey");

const router = express.Router();

// Exposed to the Ticketing team — CLAUDE.md §5.
// GET /api/peer/events/active?room=<number>
router.get(
  "/events/active",
  requirePeerApiKey("TICKETING_PEER_API_KEY"),
  async (req, res) => {
    const room = req.query.room;
    if (!room) {
      return res.status(400).json({ error: "room query param is required" });
    }

    const events = await prisma.event.findMany({
      where: {
        endsAt: { gte: new Date() },
        venue: { roomNumber: String(room) },
      },
      include: { venue: true },
    });

    res.json(events);
  }
);

module.exports = router;
