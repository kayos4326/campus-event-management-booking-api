const express = require("express");
const { prisma } = require("../services/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { searchPlaces, describeLocation } = require("../services/geoapify");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const venues = await prisma.venue.findMany({ orderBy: { name: "asc" } });
    res.json(venues);
  })
);

// Type-ahead for the venue map picker: "AU Suvarnabhumi" → places the pin can jump to.
router.get(
  "/geocode",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const query = String(req.query.q || "").trim();
    if (query.length < 3) {
      return res.status(400).json({ error: "Type at least 3 characters to search" });
    }
    res.json(await searchPlaces(query));
  })
);

// The pin is what makes a venue correct — typed addresses used to be geocoded on their
// own, which is how a venue ended up on the wrong continent (see services/geoapify.js).
router.post(
  "/",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const { name, roomNumber, addressRaw, latitude, longitude } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Venue name is required" });
    }

    const lat = Number(latitude);
    const lon = Number(longitude);
    const pinned =
      Number.isFinite(lat) && Number.isFinite(lon) &&
      lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    if (!pinned) {
      return res.status(400).json({ error: "Drop a pin on the map to set where the venue is" });
    }

    // Reverse geocoding doubles as validation: a pin in the middle of the sea has no address.
    const place = await describeLocation(lat, lon);
    if (!place) {
      return res.status(422).json({ error: "That pin isn't on a recognisable place — move it onto a building or road" });
    }

    const venue = await prisma.venue.create({
      data: {
        name: String(name).trim(),
        roomNumber: roomNumber ? String(roomNumber).trim() : null,
        // The organizer's own label wins ("AU Grand Hall, Building D"); otherwise use the pin's address.
        addressRaw: addressRaw && String(addressRaw).trim() ? String(addressRaw).trim() : place,
        latitude: lat,
        longitude: lon,
        isVerified: true,
      },
    });
    res.status(201).json(venue);
  })
);

module.exports = router;
