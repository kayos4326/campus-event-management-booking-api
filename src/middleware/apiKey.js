// Peer-API auth for the class ring (CLAUDE.md §5): a static x-api-key issued by this
// app to consumers (e.g. Ticketing). Compare against TICKETING_PEER_API_KEY.
function requirePeerApiKey(expectedEnvVar) {
  return (req, res, next) => {
    const provided = req.headers["x-api-key"];
    const expected = process.env[expectedEnvVar];
    if (!expected) {
      return res.status(500).json({ error: "Peer API key not configured" });
    }
    if (!provided || provided !== expected) {
      return res.status(401).json({ error: "Invalid or missing x-api-key" });
    }
    next();
  };
}

module.exports = { requirePeerApiKey };
