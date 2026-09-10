const express = require("express");
const crypto = require("crypto");
const { prisma } = require("../services/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { hashApiKey } = require("../middleware/apiKey");

const router = express.Router();
router.use(requireAuth, requireRole("ADMIN"));

router.get("/users", async (req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, displayName: true, role: true, createdAt: true },
  });
  res.json(users);
});

router.patch("/users/:id/role", async (req, res) => {
  const { role } = req.body;
  if (!["STUDENT", "ORGANIZER", "ADMIN"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }
  const user = await prisma.user.update({
    where: { id: Number(req.params.id) },
    data: { role },
  });
  res.json(user);
});

router.get("/events", async (req, res) => {
  const events = await prisma.event.findMany({ include: { venue: true, organizer: true } });
  res.json(events);
});

router.get("/bookings", async (req, res) => {
  const bookings = await prisma.booking.findMany({ include: { event: true, student: true } });
  res.json(bookings);
});

// Issue an API key for the exposed room-status endpoint (not tied to a specific
// consumer team — CLAUDE.md §5). The raw key is returned exactly once — only its hash
// is persisted.
router.post("/api-keys", async (req, res) => {
  const { ownerLabel, scope } = req.body;
  if (!ownerLabel || !scope) {
    return res.status(400).json({ error: "ownerLabel and scope are required" });
  }

  const rawKey = crypto.randomBytes(32).toString("hex");
  const apiKey = await prisma.apiKey.create({
    data: { ownerLabel, scope, keyHash: hashApiKey(rawKey) },
  });

  res.status(201).json({ id: apiKey.id, ownerLabel, scope, key: rawKey });
});

router.delete("/api-keys/:id", async (req, res) => {
  const apiKey = await prisma.apiKey.update({
    where: { id: Number(req.params.id) },
    data: { isActive: false },
  });
  res.json(apiKey);
});

module.exports = router;
