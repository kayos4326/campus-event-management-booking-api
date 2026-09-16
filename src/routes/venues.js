const express = require("express");
const { prisma } = require("../services/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { searchPlaces, describeLocation } = require("../services/geoapify");
const { asyncHandler } = require("../middleware/asyncHandler");
const { parseId } = require("../utils/http");
const audit = require("../services/audit");

const router = express.Router();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    // Archived venues stay on the events that already use them, but aren't offered again.
    const venues = await prisma.venue.findMany({
      where: req.query.includeArchived === "true" ? {} : { isArchived: false },
      orderBy: { name: "asc" },
    });
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
    await audit.record(req.user, {
      action: "venue.created",
      entityType: "venue",
      entityId: venue.id,
      summary: `Added venue "${venue.name}"${venue.roomNumber ? ` (room ${venue.roomNumber})` : ""}`,
    });
    res.status(201).json(venue);
  })
);

// Deleting a venue that events already point at would destroy their history, so that case
// archives instead: hidden when creating new events, still shown on the old ones.
router.delete(
  "/:id",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const venue = await prisma.venue.findUnique({ where: { id }, include: { _count: { select: { events: true } } } });
    if (!venue) return res.status(404).json({ error: "Venue not found" });

    if (venue._count.events > 0) {
      if (venue.isArchived) {
        return res.status(409).json({ error: "This venue is already archived, and it can't be deleted while events still use it" });
      }
      const archived = await prisma.venue.update({ where: { id }, data: { isArchived: true } });
      await audit.record(req.user, {
        action: "venue.archived",
        entityType: "venue",
        entityId: id,
        summary: `Archived venue "${venue.name}" (still used by ${venue._count.events} event(s))`,
      });
      return res.json({ ...archived, outcome: "archived", eventCount: venue._count.events });
    }

    await prisma.venue.delete({ where: { id } });
    await audit.record(req.user, {
      action: "venue.deleted",
      entityType: "venue",
      entityId: id,
      summary: `Deleted unused venue "${venue.name}"`,
    });
    res.json({ id, outcome: "deleted" });
  })
);

module.exports = router;
