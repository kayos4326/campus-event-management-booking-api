const express = require("express");

const venuesRouter = require("./routes/venues");
const eventsRouter = require("./routes/events");
const bookingsRouter = require("./routes/bookings");
const peerRouter = require("./routes/peer");
const adminRouter = require("./routes/admin");

function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (req, res) => res.json({ status: "ok" }));

  // Mounted under /events: Nginx's `location /events { proxy_pass
  // http://127.0.0.1:3001; }` forwards the full request URI unchanged (same
  // non-stripping pattern as the existing /api block) — see CLAUDE.md §3 and
  // docs/proposal.md's example URL (GET /events/api/peer/events/active).
  app.use("/events/api/venues", venuesRouter);
  app.use("/events/api/events", eventsRouter);
  app.use("/events/api/bookings", bookingsRouter);
  app.use("/events/api/peer", peerRouter);
  app.use("/events/api/admin", adminRouter);

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

module.exports = { createApp };
