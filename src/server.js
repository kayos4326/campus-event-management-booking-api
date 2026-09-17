// Node 18's global Web Crypto API (globalThis.crypto) is unreliable when the process is
// started as a file (`node src/server.js`) rather than via `-e` — confirmed by testing
// directly on the deploy target; @azure/identity's HTTP pipeline needs it for
// globalThis.crypto.randomUUID(). Polyfill from node:crypto before anything else loads.
if (!globalThis.crypto) {
  globalThis.crypto = require("node:crypto").webcrypto;
}

require("dotenv").config();

const { loadSecrets } = require("./config/keyvault");

const PORT = process.env.PORT || 3001;

async function bootstrapServer() {
  await loadSecrets();

  // Deferred until after loadSecrets(): app.js transitively requires
  // services/prisma.js, which constructs `new PrismaClient()` at module-load time.
  // PrismaClient reads and caches DATABASE_URL at construction, not per-query —
  // confirmed directly (a client built before DATABASE_URL is set fails on every
  // later query even once the env var is set). Matches the taught pattern: Week 9's
  // lab constructs PrismaClient inside bootstrapServer(), after the secret fetch.
  const { createApp } = require("./app");
  const outbox = require("./services/outbox");
  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`campus-event-api listening on :${PORT}`);
  });

  // Delivers queued work such as supply orders (services/outbox.js). OUTBOX_WORKER=off
  // runs the API without it, e.g. a second copy that shouldn't send anything.
  if (process.env.OUTBOX_WORKER !== "off") outbox.startWorker();

  // PM2 sends SIGINT on restart. Stop taking jobs and let the one in flight finish, well
  // inside PM2's 1.6s kill timeout; anything cut off is retried once its lease runs out.
  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close();
    await outbox.stopWorker({ timeoutMs: 1000 });
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

bootstrapServer().catch((err) => {
  console.error("Failed to bootstrap server:", err);
  process.exit(1);
});
