const express = require("express");
const path = require("path");
const { corsPolicy, securityHeaders, readLimiter, writeLimiter } = require("./middleware/security");

const venuesRouter = require("./routes/venues");
const eventsRouter = require("./routes/events");
const bookingsRouter = require("./routes/bookings");
const peerRouter = require("./routes/peer");
const adminRouter = require("./routes/admin");
const meRouter = require("./routes/me");
const { HttpError } = require("./utils/http");

function createApp() {
  const app = express();
  // Nginx sits in front (see CLAUDE.md §3), so trust its X-Forwarded-For for client IPs.
  app.set("trust proxy", 1);
  app.use(securityHeaders);
  app.use(corsPolicy); // only our own frontend may call the API from a browser
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (req, res) => res.json({ status: "ok" }));

  // Abuse protection on the API only — the frontend's own files aren't rate limited.
  app.use("/events/api", readLimiter(), writeLimiter());

  // Mounted under /events: Nginx's `location /events { proxy_pass
  // http://127.0.0.1:3001; }` forwards the full request URI unchanged (same
  // non-stripping pattern as the existing /api block) — see CLAUDE.md §3.
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
