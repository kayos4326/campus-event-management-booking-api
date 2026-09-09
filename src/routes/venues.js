const express = require("express");
const { prisma } = require("../services/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const venues = await prisma.venue.findMany();
  res.json(venues);
});

router.post("/", requireAuth, requireRole("ORGANIZER"), async (req, res) => {
  const { name, address, roomNumber } = req.body;
  if (!name || !address) {
    return res.status(400).json({ error: "name and address are required" });
  }

  // TODO: call Geoapify to validate `address` and generate mapUrl/lat/lng
  // before persisting — see CLAUDE.md §2 and §8 (API key not yet obtained).
  const venue = await prisma.venue.create({
    data: { name, address, roomNumber },
  });
  res.status(201).json(venue);
});

module.exports = router;
