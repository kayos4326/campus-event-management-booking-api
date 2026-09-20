const express = require("express");
const { prisma } = require("../services/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { searchPlaces, describeLocation } = require("../services/geoapify");
const { asyncHandler } = require("../middleware/asyncHandler");
const { validate } = require("../validation/validate");
const schemas = require("../validation/schemas");
const audit = require("../services/audit");

const router = express.Router();

router.get(
  "/",
  requireAuth,
  validate({ query: schemas.venueList }),
  asyncHandler(async (req, res) => {
    // Archived venues stay on the events that already use them, but aren't offered again.
    const venues = await prisma.venue.findMany({
      where: req.valid.query.includeArchived ? {} : { isArchived: false },
      orderBy: { name: "asc" },
    });
    res.json(venues);
  })
);

// Place suggestions for the map picker.
router.get(
  "/geocode",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  validate({ query: schemas.geocodeQuery }),
  asyncHandler(async (req, res) => {
    res.json(await searchPlaces(req.valid.query.q));
  })
);

// A map pin is required; Geoapify validates it and supplies a readable address.
router.post(
  "/",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  validate({ body: schemas.venueCreate }),
  asyncHandler(async (req, res) => {
    const { name, roomNumber, addressRaw, latitude: lat, longitude: lon } = req.valid.body;

    // Reverse geocoding doubles as validation: a pin in the middle of the sea has no address.
    const place = await describeLocation(lat, lon);
    if (!place) {
      return res.status(422).json({ error: "That pin isn't on a recognisable place — move it onto a building or road" });
    }

    const venue = await prisma.venue.create({
      data: {
        name,
        roomNumber: roomNumber ?? null,
        // Prefer the organizer's label and keep the value within the database column.
        addressRaw: addressRaw ?? place.slice(0, 191),
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

// Labels can be corrected, but moving the pin would silently relocate existing events.
router.patch(
  "/:id",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  validate({ params: schemas.idParams, body: schemas.venueUpdate }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    const changes = req.valid.body;

    const venue = await prisma.venue.findUnique({ where: { id } });
    if (!venue) return res.status(404).json({ error: "Venue not found" });

    const updated = await prisma.venue.update({ where: { id }, data: changes });

    // Store a concise, readable summary in the Activity view.
    const changed = [];
    if (changes.name !== undefined && changes.name !== venue.name) {
      changed.push(`renamed to "${updated.name}"`);
    }
    if (changes.roomNumber !== undefined && changes.roomNumber !== venue.roomNumber) {
      changed.push(updated.roomNumber ? `room set to ${updated.roomNumber}` : "room number cleared");
    }
    if (changes.addressRaw !== undefined && changes.addressRaw !== venue.addressRaw) {
      changed.push(updated.addressRaw ? "address label updated" : "address label cleared");
    }

    await audit.record(req.user, {
      action: "venue.updated",
      entityType: "venue",
      entityId: id,
      summary: changed.length
        ? `Edited venue "${venue.name}": ${changed.join(", ")}`
        : `Edited venue "${venue.name}"`,
    });
    res.json(updated);
  })
);

// Used venues are archived instead of deleted so historical events remain valid.
router.delete(
  "/:id",
  requireAuth,
  requireRole("ORGANIZER", "ADMIN"),
  validate({ params: schemas.idParams }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
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
