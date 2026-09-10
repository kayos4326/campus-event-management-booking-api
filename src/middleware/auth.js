const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");
const { prisma } = require("../services/prisma");
const { asyncHandler } = require("./asyncHandler");

// Validates Entra ID (AD) access tokens — docs/proposal.md: "Authentication: Microsoft
// Active Directory (Entra ID, OIDC)". Requires TENANT_ID + CLIENT_ID (audience) set via
// bootstrap config — see CLAUDE.md §4.
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

// The DB model allows exactly one role per user (see prisma/schema.prisma), but a
// token's `roles` claim is an array — a user could in principle hold more than one
// Entra App Role. ADMIN beats ORGANIZER beats STUDENT when more than one is assigned.
const ROLE_PRIORITY = ["ADMIN", "ORGANIZER", "STUDENT"];
function resolveRole(claimRoles) {
  return ROLE_PRIORITY.find((r) => (claimRoles || []).includes(r)) || "STUDENT";
}

// asyncHandler wrapped: this runs on every authenticated request, and its
// prisma.user.upsert() call can throw — without wrapping, Express 4 would hang the
// request instead of returning an error (confirmed directly — see asyncHandler.js).
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

  // Provision the local User row on first sign-in. Role is only set from the token's
  // App Roles claim at creation time — an existing user's role is NOT overwritten on
  // every login, since Admins manage roles through our own /admin endpoints
  // (docs/proposal.md), and Entra App Role assignment shouldn't silently clobber that.
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

  req.user = { ...decoded, id: user.id, role: user.role };
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

module.exports = { requireAuth, requireRole };
