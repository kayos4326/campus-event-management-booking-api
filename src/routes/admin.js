const express = require("express");
const crypto = require("crypto");
const { prisma } = require("../services/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { hashApiKey } = require("../middleware/apiKey");
const { asyncHandler } = require("../middleware/asyncHandler");
const { validate } = require("../validation/validate");
const schemas = require("../validation/schemas");
const { withSeatCounts } = require("../services/bookings");
const { IMAGE_SELECT, withImageUrl } = require("../services/eventImages");
const audit = require("../services/audit");

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
  validate({ params: schemas.idParams, body: schemas.roleChange }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    const { role } = req.valid.body;
    // Demoting yourself locks you out of this panel immediately, with no way back
    // through the app (happened twice during testing). Another Admin has to do it.
    if (id === req.user.id && role !== "ADMIN") {
      return res.status(400).json({ error: "You can't remove your own Admin role — ask another Admin" });
    }
    const before = await prisma.user.findUnique({ where: { id } });
    const user = await prisma.user.update({
      where: { id },
      data: { role },
    });
    await audit.record(req.user, {
      action: "user.role_changed",
      entityType: "user",
      entityId: user.id,
      summary: `Changed ${user.displayName || user.email}'s role: ${(before?.role || "?").toLowerCase()} → ${role.toLowerCase()}`,
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
        preorder: true,
        image: IMAGE_SELECT,
      },
      orderBy: { startsAt: "desc" },
    });
    res.json((await withSeatCounts(events)).map(withImageUrl));
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

// Who changed what, newest first — the answer to "who cancelled this event?".
// `before` pages backwards: the Activity tab sends the id of the oldest entry it is
// already showing, and gets the next batch older than it. Sorting by id as well as by
// time keeps that reliable when several entries share a timestamp — without it, one of
// them could be skipped or shown twice across a page boundary.
router.get(
  "/audit",
  validate({ query: schemas.auditQuery }),
  asyncHandler(async (req, res) => {
    const { limit, before } = req.valid.query;
    const entries = await prisma.auditLog.findMany({
      ...(before && { where: { id: { lt: before } } }),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });
    res.json(entries);
  })
);

// Every key ever issued (active and revoked) so an Admin can revoke one issued in an
// earlier session — without this the UI could only revoke keys issued since page load.
router.get(
  "/api-keys",
  asyncHandler(async (req, res) => {
    const keys = await prisma.apiKey.findMany({
      select: { id: true, ownerLabel: true, scope: true, isActive: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(keys);
  })
);

// Issue an API key for the exposed room-status endpoint (not tied to a specific
// consumer team — CLAUDE.md §5). The raw key is returned exactly once — only its hash
// is persisted.
router.post(
  "/api-keys",
  validate({ body: schemas.apiKeyCreate }),
  asyncHandler(async (req, res) => {
    const { ownerLabel, scope } = req.valid.body;

    const rawKey = crypto.randomBytes(32).toString("hex");
    const apiKey = await prisma.apiKey.create({
      data: { ownerLabel, scope, keyHash: hashApiKey(rawKey) },
    });

    await audit.record(req.user, {
      action: "apiKey.issued",
      entityType: "apiKey",
      entityId: apiKey.id,
      summary: `Issued an API key for "${ownerLabel}" (${scope})`,
    });

    res.status(201).json({
      id: apiKey.id,
      ownerLabel,
      scope,
      isActive: apiKey.isActive,
      createdAt: apiKey.createdAt,
      key: rawKey,
    });
  })
);

router.delete(
  "/api-keys/:id",
  validate({ params: schemas.idParams }),
  asyncHandler(async (req, res) => {
    const apiKey = await prisma.apiKey.update({
      where: { id: req.valid.params.id },
      data: { isActive: false },
      // Never send the stored hash back out, even for a revoked key.
      select: { id: true, ownerLabel: true, scope: true, isActive: true, createdAt: true },
    });
    await audit.record(req.user, {
      action: "apiKey.revoked",
      entityType: "apiKey",
      entityId: apiKey.id,
      summary: `Revoked the API key for "${apiKey.ownerLabel}"`,
    });
    res.json(apiKey);
  })
);

module.exports = router;
