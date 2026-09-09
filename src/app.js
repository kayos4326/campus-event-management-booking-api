const express = require("express");

const venuesRouter = require("./routes/venues");
const eventsRouter = require("./routes/events");
const bookingsRouter = require("./routes/bookings");
const peerRouter = require("./routes/peer");

function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (req, res) => res.json({ status: "ok" }));

  app.use("/api/venues", venuesRouter);
  app.use("/api/events", eventsRouter);
  app.use("/api/bookings", bookingsRouter);
  app.use("/api/peer", peerRouter);

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

module.exports = { createApp };
