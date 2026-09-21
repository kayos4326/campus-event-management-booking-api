const crypto = require("crypto");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// Browser requests are allowed only from our frontend and local test pages.
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
    callback(null, false);
  },
});

const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  // React and Leaflet use inline styles.
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
  // OpenStreetMap tiles and inline icons.
  imgSrc: ["'self'", "data:", "blob:", "https://tile.openstreetmap.org", "https://*.tile.openstreetmap.org"],
  connectSrc: ["'self'", "https://login.microsoftonline.com", "https://tile.openstreetmap.org"],
  frameSrc: ["https://login.microsoftonline.com"],
  frameAncestors: ["'none'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
};

// OpenStreetMap requires a referrer. This policy sends only our origin.
const REFERRER_POLICY = "strict-origin-when-cross-origin";

const securityHeaders = helmet({
  contentSecurityPolicy: { directives: cspDirectives },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: REFERRER_POLICY },
});

// Rate-limit by login, API key or client IP.
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
    validate: false,
    handler: (req, res) => res.status(429).json({ error: message }),
  });

const readLimiter = () =>
  limiter(Number(process.env.RATE_LIMIT_REQUESTS || 1000), "Too many requests — slow down and try again in a few minutes");

// Writes have a lower limit than reads.
const writeLimiter = () => {
  const limit = limiter(
    Number(process.env.RATE_LIMIT_WRITES || 200),
    "Too many changes in a short time — try again in a few minutes"
  );
  return (req, res, next) => (req.method === "GET" ? next() : limit(req, res, next));
};

module.exports = { corsPolicy, securityHeaders, readLimiter, writeLimiter, cspDirectives, REFERRER_POLICY };
