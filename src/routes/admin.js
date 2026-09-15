const express = require("express");
const crypto = require("crypto");
const { prisma } = require("../services/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { hashApiKey } = require("../middleware/apiKey");
const { asyncHandler } = require("../middleware/asyncHandler");
const { parseId } = require("../utils/http");
const { withSeatCounts } = require("../services/bookings");

const router = express.Router();
router.use(requireAuth, requireRole("ADMIN"));

router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, displayName: true, role: true, createdAt: true },
    });
    res.json(users);
  })
);

router.patch(
  "/users/:id/role",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const { role } = req.body;
    if (!["STUDENT", "ORGANIZER", "ADMIN"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    // Demoting yourself locks you out of this panel immediately, with no way back
    // through the app (happened twice during testing). Another Admin has to do it.
    if (id === req.user.id && role !== "ADMIN") {
      return res.status(400).json({ error: "You can't remove your own Admin role — ask another Admin" });
    }
    const user = await prisma.user.update({
      where: { id },
      data: { role },
    });
    res.json(user);
  })
);

router.get(
  "/events",
  asyncHandler(async (req, res) => {
    const events = await prisma.event.findMany({
      include: {
        venue: true,
        organizer: { select: { id: true, displayName: true, email: true } },
      },
      orderBy: { startsAt: "desc" },
    });
    res.json(await withSeatCounts(events));
  })
);

router.get(
  "/bookings",
  asyncHandler(async (req, res) => {
    const bookings = await prisma.booking.findMany({
      include: {
        event: { select: { id: true, title: true, startsAt: true } },
        student: { select: { id: true, displayName: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(bookings);
  })
);

// Issue an API key for the exposed room-status endpoint (not tied to a specific
// consumer team — CLAUDE.md §5). The raw key is returned exactly once — only its hash
// is persisted.
router.post(
  "/api-keys",
  asyncHandler(async (req, res) => {
    const { ownerLabel, scope } = req.body;
    if (!ownerLabel || !scope) {
      return res.status(400).json({ error: "ownerLabel and scope are required" });
    }

    const rawKey = crypto.randomBytes(32).toString("hex");
    const apiKey = await prisma.apiKey.create({
      data: { ownerLabel, scope, keyHash: hashApiKey(rawKey) },
    });

    res.status(201).json({ id: apiKey.id, ownerLabel, scope, key: rawKey });
  })
);

router.delete(
  "/api-keys/:id",
  asyncHandler(async (req, res) => {
    const apiKey = await prisma.apiKey.update({
      where: { id: parseId(req.params.id) },
      data: { isActive: false },
    });
    res.json(apiKey);
  })
);

module.exports = router;
