const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();

// Return the local profile and admin-managed role.
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ id: req.user.id, email: req.user.email, displayName: req.user.displayName, role: req.user.role });
  })
);

module.exports = router;
