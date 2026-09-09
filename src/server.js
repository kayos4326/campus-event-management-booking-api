// Node 18's global Web Crypto API (globalThis.crypto) is unreliable when the process is
// started as a file (`node src/server.js`) rather than via `-e` — confirmed by testing
// directly on the deploy target; @azure/identity's HTTP pipeline needs it for
// globalThis.crypto.randomUUID(). Polyfill from node:crypto before anything else loads.
if (!globalThis.crypto) {
  globalThis.crypto = require("node:crypto").webcrypto;
}

require("dotenv").config();

const { loadSecrets } = require("./config/keyvault");
const { createApp } = require("./app");

const PORT = process.env.PORT || 3001;

async function bootstrapServer() {
  await loadSecrets();

  const app = createApp();
  app.listen(PORT, () => {
    console.log(`campus-event-api listening on :${PORT}`);
  });
}

bootstrapServer().catch((err) => {
  console.error("Failed to bootstrap server:", err);
  process.exit(1);
});
