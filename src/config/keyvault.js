const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");

// Secrets fetched at runtime — see CLAUDE.md §4. No secrets live in .env in production;
// .env only holds bootstrap config (tenant/client IDs, vault URL) needed to reach the vault.
const SECRET_NAMES = [
  "database-url",
  "jwt-signing-key",
  "geoapify-api-key",
  "merch-peer-api-key",
  "ticketing-peer-api-key",
];

async function loadSecrets() {
  const vaultUrl = process.env.KEY_VAULT_URL;
  if (!vaultUrl) {
    throw new Error("KEY_VAULT_URL is not set — cannot bootstrap secrets");
  }

  const credential = new DefaultAzureCredential();
  const client = new SecretClient(vaultUrl, credential);

  const entries = await Promise.all(
    SECRET_NAMES.map(async (name) => {
      const secret = await client.getSecret(name);
      return [name, secret.value];
    })
  );

  const secrets = Object.fromEntries(entries);

  // Map vault secret names to the env vars the rest of the app expects.
  process.env.DATABASE_URL = secrets["database-url"];
  process.env.JWT_SIGNING_KEY = secrets["jwt-signing-key"];
  process.env.GEOAPIFY_API_KEY = secrets["geoapify-api-key"];
  process.env.MERCH_PEER_API_KEY = secrets["merch-peer-api-key"];
  process.env.TICKETING_PEER_API_KEY = secrets["ticketing-peer-api-key"];

  return secrets;
}

module.exports = { loadSecrets };
