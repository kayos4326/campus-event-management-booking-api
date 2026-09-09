const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");

// Secrets fetched at runtime — see CLAUDE.md §4 / docs/proposal.md. No secrets live in
// .env in production; .env only holds bootstrap config (Key Vault URL, port, Entra
// tenant/client IDs) needed to reach the vault and validate Entra-issued tokens.
//
// No JWT signing secret here: auth is Entra ID/OIDC (JWKS-validated), not self-issued
// JWTs, so there's no shared secret to store. Peer keys we ISSUE (e.g. to HelpDesk) are
// stored hashed in the ApiKey table, not here — only keys ISSUED TO US live in the vault.
//
// database-url is required — nothing works without a DB. geoapify-api-key and
// merch-peer-api-key are genuinely not obtained yet (external dependencies, CLAUDE.md
// §8), so they're optional at boot: missing ones are skipped with a warning rather than
// blocking the whole app — venue creation / merch pre-order simply fail at the point of
// use until those keys exist, instead of nothing working at all.
const REQUIRED_SECRETS = ["database-url"];
const OPTIONAL_SECRETS = ["geoapify-api-key", "merch-peer-api-key"];

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
  if (secrets["geoapify-api-key"]) process.env.GEOAPIFY_API_KEY = secrets["geoapify-api-key"];
  if (secrets["merch-peer-api-key"]) process.env.MERCH_PEER_API_KEY = secrets["merch-peer-api-key"];

  return secrets;
}

module.exports = { loadSecrets };
