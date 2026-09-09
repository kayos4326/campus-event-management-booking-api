const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");

// Validates Entra ID (AD) access tokens. Requires TENANT_ID + CLIENT_ID (audience)
// set via bootstrap config — see CLAUDE.md §4. Tenant/vault provisioning status is
// still unconfirmed (§8), so this path is untested against a live tenant.
const client = jwksClient({
  jwksUri: `https://login.microsoftonline.com/${process.env.TENANT_ID}/discovery/v2.0/keys`,
});

function getSigningKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }
  const token = authHeader.slice("Bearer ".length);

  jwt.verify(
    token,
    getSigningKey,
    {
      audience: process.env.CLIENT_ID,
      issuer: `https://login.microsoftonline.com/${process.env.TENANT_ID}/v2.0`,
      algorithms: ["RS256"],
    },
    (err, decoded) => {
      if (err) return res.status(401).json({ error: "Invalid token" });
      req.user = decoded;
      next();
    }
  );
}

function requireRole(...roles) {
  return (req, res, next) => {
    const userRoles = req.user?.roles || [];
    if (!roles.some((r) => userRoles.includes(r))) {
      return res.status(403).json({ error: "Insufficient role" });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
