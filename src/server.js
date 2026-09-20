// Azure Identity needs Web Crypto; provide it for Node 18 before loading the SDK.
if (!globalThis.crypto) {
  globalThis.crypto = require("node:crypto").webcrypto;
}

require("dotenv").config();

const { loadSecrets } = require("./config/keyvault");

const PORT = process.env.PORT || 3001;

async function bootstrapServer() {
  await loadSecrets();

  // Prisma reads DATABASE_URL when it is constructed, so load application modules only
  // after Key Vault has populated the environment.
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
