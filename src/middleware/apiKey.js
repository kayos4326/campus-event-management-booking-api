const crypto = require("crypto");
const { prisma } = require("../services/prisma");

function hashApiKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

// Peer-API auth for keys WE issue (e.g. to HelpDesk) — docs/proposal.md: "We generate
// an API key and issue it only to their team. The key is stored as a hash in our
// database." Checked against the ApiKey table, not a static env var.
function requirePeerApiKey(scope) {
  return async (req, res, next) => {
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
  };
}

module.exports = { requirePeerApiKey, hashApiKey };
