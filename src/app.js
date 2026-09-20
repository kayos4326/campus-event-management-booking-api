const express = require("express");
const fs = require("fs");
const path = require("path");
const { corsPolicy, securityHeaders, readLimiter, writeLimiter } = require("./middleware/security");

const venuesRouter = require("./routes/venues");
const eventsRouter = require("./routes/events");
const bookingsRouter = require("./routes/bookings");
const peerRouter = require("./routes/peer");
const adminRouter = require("./routes/admin");
const meRouter = require("./routes/me");
const { HttpError } = require("./utils/http");

// Which release is running: deploy.sh writes a RELEASE file into each release directory.
const RELEASE = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, "../RELEASE"), "utf8").trim();
  } catch {
    return process.env.RELEASE || "dev";
  }
})();

function createApp() {
  const app = express();
  // Trust the single Nginx proxy when applying per-client rate limits.
  app.set("trust proxy", 1);
  app.use(securityHeaders);
  app.use(corsPolicy); // only our own frontend may call the API from a browser
  app.use(express.json({ limit: "100kb" }));

  // Only reachable on the VM itself — Nginx forwards /events, not /health. deploy.sh uses it
  // after switching releases: `release` proves the new code is what's answering, and
  // ?deep=1 that it can reach the database too.
  app.get("/health", async (req, res) => {
    const health = { status: "ok", release: RELEASE };
    if (req.query.deep !== "1") return res.json(health);
    try {
      await require("./services/prisma").prisma.$queryRaw`SELECT 1`;
      res.json({ ...health, database: "ok" });
    } catch {
      res.status(503).json({ ...health, status: "error", database: "unreachable" });
    }
  });

  // Abuse protection on the API only — the frontend's own files aren't rate limited.
  app.use("/events/api", readLimiter(), writeLimiter());

  // All application routes live under /events so existing VPS routes remain untouched.
  app.use("/events/api/venues", venuesRouter);
  app.use("/events/api/events", eventsRouter);
  app.use("/events/api/bookings", bookingsRouter);
  app.use("/events/api/peer", peerRouter);
  app.use("/events/api/admin", adminRouter);
  app.use("/events/api/me", meRouter);

  // Built React frontend (frontend-ui/), served after the API routes above so
  // /events/api/* is never shadowed by this catch-all.
  app.use("/events", express.static(path.join(__dirname, "../frontend-ui/dist")));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Request body is not valid JSON" });
    }
    // A cover image bigger than the cap in services/eventImages.js.
    if (err.type === "entity.too.large") {
      return res.status(413).json({ error: "That file is too large — use an image under 2 MB" });
    }
    // P2025: the record to update doesn't exist (e.g. a role change for an unknown user id).
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Not found" });
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

module.exports = { createApp };
