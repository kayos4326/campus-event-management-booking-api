const crypto = require("crypto");
const { prisma } = require("../services/prisma");
const { asyncHandler } = require("./asyncHandler");

function hashApiKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

// Authenticate external backends with scoped keys whose hashes are stored in MySQL.
function requirePeerApiKey(scope) {
  return asyncHandler(async (req, res, next) => {
    const provided = req.headers["x-api-key"];
    if (!provided) {
      return res.status(401).json({ error: "Missing x-api-key" });
    }

    const key = await prisma.apiKey.findFirst({
      where: { keyHash: hashApiKey(provided), scope, isActive: true },
    });
    if (!key) {
      return res.status(401).json({ error: "Invalid or revoked x-api-key" });
    }

    next();
  });
}

module.exports = { requirePeerApiKey, hashApiKey };
