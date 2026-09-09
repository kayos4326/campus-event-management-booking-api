const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");

// Secrets fetched at runtime — see CLAUDE.md §4 / docs/proposal.md. No secrets live in
// .env in production; .env only holds bootstrap config (Key Vault URL, port, Entra
// tenant/client IDs) needed to reach the vault and validate Entra-issued tokens.
//
// No JWT signing secret here: auth is Entra ID/OIDC (JWKS-validated), not self-issued
// JWTs, so there's no shared secret to store. Peer keys we ISSUE (e.g. to HelpDesk) are
// stored hashed in the ApiKey table, not here — only keys ISSUED TO US live in the vault.
const SECRET_NAMES = ["database-url", "geoapify-api-key", "merch-peer-api-key"];

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
  process.env.GEOAPIFY_API_KEY = secrets["geoapify-api-key"];
  process.env.MERCH_PEER_API_KEY = secrets["merch-peer-api-key"];

  return secrets;
}

module.exports = { loadSecrets };
