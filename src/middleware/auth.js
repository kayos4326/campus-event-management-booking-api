const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");
const { prisma } = require("../services/prisma");
const { asyncHandler } = require("./asyncHandler");

// Microsoft publishes the RS256 public keys used to verify Entra access tokens.
const client = jwksClient({
  jwksUri: `https://login.microsoftonline.com/${process.env.TENANT_ID}/discovery/v2.0/keys`,
});

function getSigningKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function verifyJwt(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getSigningKey,
      {
        audience: process.env.CLIENT_ID,
        issuer: `https://login.microsoftonline.com/${process.env.TENANT_ID}/v2.0`,
        algorithms: ["RS256"],
      },
      (err, decoded) => (err ? reject(err) : resolve(decoded))
    );
  });
}

// The database stores one role; use the highest role when Entra supplies several.
const ROLE_PRIORITY = ["ADMIN", "ORGANIZER", "STUDENT"];
function resolveRole(claimRoles) {
  return ROLE_PRIORITY.find((r) => (claimRoles || []).includes(r)) || "STUDENT";
}

const requireAuth = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }
  const token = authHeader.slice("Bearer ".length);

  let decoded;
  try {
    decoded = await verifyJwt(token);
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }

  // First sign-in creates the local profile. Existing roles remain Admin-managed.
  const user = await prisma.user.upsert({
    where: { adObjectId: decoded.oid },
    update: {},
    create: {
      adObjectId: decoded.oid,
      email: decoded.preferred_username || decoded.upn || decoded.email,
      displayName: decoded.name || decoded.preferred_username || "Unknown",
      role: resolveRole(decoded.roles),
    },
  });

  // The local profile is authoritative after provisioning.
  req.user = { ...decoded, id: user.id, role: user.role, email: user.email, displayName: user.displayName };
  next();
});

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: "Insufficient role" });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, resolveRole };
