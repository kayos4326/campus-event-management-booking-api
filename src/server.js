// Azure Identity needs Web Crypto on Node 18.
if (!globalThis.crypto) {
  globalThis.crypto = require("node:crypto").webcrypto;
}

require("dotenv").config();

const { loadSecrets } = require("./config/keyvault");

const PORT = process.env.PORT || 3001;

async function bootstrapServer() {
  await loadSecrets();

  // Load Prisma only after Key Vault provides DATABASE_URL.
  const { createApp } = require("./app");
  const outbox = require("./services/outbox");
  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`campus-event-api listening on :${PORT}`);
  });

  // The outbox worker sends queued supply requests.
  if (process.env.OUTBOX_WORKER !== "off") outbox.startWorker();

  // Stop accepting work cleanly when PM2 restarts the app.
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
