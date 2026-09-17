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
// see CLAUDE.md §5) is optional at boot: without it, supply orders wait in the outbox and
// are retried (services/outbox.js) instead of the whole app refusing to start.
const REQUIRED_SECRETS = ["database-url", "geoapify-api-key"];
const OPTIONAL_SECRETS = ["discord-webhook-url"];

// Vault secret name → the env var the rest of the app reads.
const ENV_VAR = {
  "database-url": "DATABASE_URL",
  "geoapify-api-key": "GEOAPIFY_API_KEY",
  "discord-webhook-url": "DISCORD_WEBHOOK_URL",
};

async function loadSecrets() {
  const secrets = {};
  const wanted = [...REQUIRED_SECRETS, ...OPTIONAL_SECRETS];

  // Already supplied by the environment? Use it and don't ask the vault. That's how
  // `docker compose up` runs the whole stack on a laptop, where there's no managed
  // identity to authenticate with. Production (the VM) sets none of these, so it still
  // reads everything from Key Vault.
  const missing = wanted.filter((name) => !process.env[ENV_VAR[name]]);
  for (const name of wanted) {
    if (!missing.includes(name)) secrets[name] = process.env[ENV_VAR[name]];
  }

  const missingRequired = REQUIRED_SECRETS.filter((name) => missing.includes(name));
  if (missing.length > 0) {
    const vaultUrl = process.env.KEY_VAULT_URL;
    if (!vaultUrl) {
      if (missingRequired.length > 0) {
        throw new Error(
          `KEY_VAULT_URL is not set and these secrets aren't in the environment either: ${missingRequired
            .map((n) => ENV_VAR[n])
            .join(", ")}`
        );
      }
    } else {
      const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
      for (const name of missing) {
        try {
          secrets[name] = (await client.getSecret(name)).value;
        } catch (err) {
          if (REQUIRED_SECRETS.includes(name)) throw err;
          console.warn(`⚠️  Optional secret "${name}" not found in Key Vault — skipping.`);
        }
      }
    }
  }

  for (const [name, value] of Object.entries(secrets)) {
    if (value) process.env[ENV_VAR[name]] = value;
  }

  const stillMissing = REQUIRED_SECRETS.filter((name) => !process.env[ENV_VAR[name]]);
  if (stillMissing.length > 0) {
    throw new Error(`Missing required secrets: ${stillMissing.join(", ")}`);
  }

  return secrets;
}

module.exports = { loadSecrets };
