const crypto = require("crypto");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// Only our own frontend is allowed to call the API from a browser. Anything without an
// Origin header (curl, the room-status API's consumers, server-to-server) is unaffected —
// those are authenticated by bearer token or x-api-key, not by origin.
const DEFAULT_ORIGINS = [
  "https://chaotic-hell.eastasia.cloudapp.azure.com",
  "http://localhost:5173", // frontend dev server
  "http://127.0.0.1:4173", // e2e test build
];
const allowedOrigins = (process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(","))
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const corsPolicy = cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(null, false); // no CORS headers → the browser blocks the response
  },
});

// Exported so the e2e test build can serve the app under the very same policy.
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  // React and Leaflet set inline styles; the fonts come from Google Fonts.
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
  // Map tiles (OpenStreetMap) and inline SVG/data-URI icons.
  imgSrc: ["'self'", "data:", "blob:", "https://tile.openstreetmap.org", "https://*.tile.openstreetmap.org"],
  connectSrc: ["'self'", "https://login.microsoftonline.com", "https://tile.openstreetmap.org"],
  frameSrc: ["https://login.microsoftonline.com"], // MSAL's silent token refresh
  frameAncestors: ["'none'"], // nobody can embed this app in an iframe
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
};

const securityHeaders = helmet({
  contentSecurityPolicy: { directives: cspDirectives },
  crossOriginEmbedderPolicy: false, // would block the map tiles
});

// Rate limits are per signed-in user (or per API key), falling back to the client IP for
// unauthenticated calls — so one noisy account can't lock everyone else out.
function identity(req) {
  const credential = req.get("authorization") || req.get("x-api-key");
  if (credential) return `key:${crypto.createHash("sha256").update(credential).digest("hex").slice(0, 32)}`;
  return `ip:${req.ip}`;
}

const WINDOW_MS = 5 * 60 * 1000;
const limiter = (max, message) =>
  rateLimit({
    windowMs: WINDOW_MS,
    max,
    keyGenerator: identity,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false, // we supply our own key, so the proxy/IP checks don't apply
    handler: (req, res) => res.status(429).json({ error: message }),
  });

const readLimiter = () =>
  limiter(Number(process.env.RATE_LIMIT_REQUESTS || 1000), "Too many requests — slow down and try again in a few minutes");

// Writes (create/update/cancel) get a tighter budget than reads.
const writeLimiter = () => {
  const limit = limiter(
    Number(process.env.RATE_LIMIT_WRITES || 200),
    "Too many changes in a short time — try again in a few minutes"
  );
  return (req, res, next) => (req.method === "GET" ? next() : limit(req, res, next));
};

module.exports = { corsPolicy, securityHeaders, readLimiter, writeLimiter, allowedOrigins, cspDirectives };
