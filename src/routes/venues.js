const express = require("express");
const { prisma } = require("../services/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { geocodeAddress } = require("../services/geoapify");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const venues = await prisma.venue.findMany();
  res.json(venues);
});

router.post("/", requireAuth, requireRole("ORGANIZER", "ADMIN"), async (req, res) => {
  const { name, roomNumber, addressRaw } = req.body;
  if (!name || !addressRaw) {
    return res.status(400).json({ error: "name and addressRaw are required" });
  }

  const geo = await geocodeAddress(addressRaw);
  if (!geo) {
    return res.status(422).json({ error: "Address does not resolve to a real place" });
  }

  const venue = await prisma.venue.create({
    data: { name, roomNumber, addressRaw, ...geo, isVerified: true },
  });
  res.status(201).json(venue);
});

module.exports = router;
