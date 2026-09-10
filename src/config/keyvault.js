const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");

// Secrets fetched at runtime — see CLAUDE.md §4. No secrets live in .env in production;
// .env only holds bootstrap config (Key Vault URL, port, Entra tenant/client IDs) needed
// to reach the vault and validate Entra-issued tokens.
//
// No JWT signing secret here: auth is Entra ID/OIDC (JWKS-validated), not self-issued
// JWTs, so there's no shared secret to store. Peer keys we ISSUE to consumers of our own
// exposed endpoint are stored hashed in the ApiKey table, not here — only credentials
// ISSUED TO US (Geoapify, Discord) live in the vault.
//
// database-url and geoapify-api-key are required — nothing works without a DB, and
// Geoapify is core to venue creation. discord-webhook-url (replaces the old
// merch-peer-api-key since the peer-to-classmate integration was dropped 2026-09-10 —
// see CLAUDE.md §5) is genuinely not obtained yet, so it's optional at boot: missing
// just means the large-conference notification silently no-ops instead of blocking the
// whole app.
const REQUIRED_SECRETS = ["database-url", "geoapify-api-key"];
const OPTIONAL_SECRETS = ["discord-webhook-url"];

async function loadSecrets() {
  const vaultUrl = process.env.KEY_VAULT_URL;
  if (!vaultUrl) {
    throw new Error("KEY_VAULT_URL is not set — cannot bootstrap secrets");
  }

  const credential = new DefaultAzureCredential();
  const client = new SecretClient(vaultUrl, credential);

  const secrets = {};

  for (const name of REQUIRED_SECRETS) {
    const secret = await client.getSecret(name);
    secrets[name] = secret.value;
  }

  for (const name of OPTIONAL_SECRETS) {
    try {
      const secret = await client.getSecret(name);
      secrets[name] = secret.value;
    } catch (err) {
      console.warn(`⚠️  Optional secret "${name}" not found in Key Vault — skipping.`);
    }
  }

  // Map vault secret names to the env vars the rest of the app expects.
  process.env.DATABASE_URL = secrets["database-url"];
  process.env.GEOAPIFY_API_KEY = secrets["geoapify-api-key"];
  if (secrets["discord-webhook-url"]) process.env.DISCORD_WEBHOOK_URL = secrets["discord-webhook-url"];

  return secrets;
}

module.exports = { loadSecrets };
