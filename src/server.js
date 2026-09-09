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
