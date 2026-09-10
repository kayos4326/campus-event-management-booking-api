const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();

// The frontend needs this to know the logged-in user's actual role, since role is
// DB-authoritative (Admin-managed, not just whatever the token's roles claim says —
// see src/middleware/auth.js's comment on why role isn't overwritten after creation).
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ id: req.user.id, email: req.user.email, displayName: req.user.displayName, role: req.user.role });
  })
);

module.exports = router;
