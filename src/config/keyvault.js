const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");

// Production reads secrets from Key Vault. Local Docker can use env vars.
const REQUIRED_SECRETS = ["database-url", "geoapify-api-key"];
const OPTIONAL_SECRETS = ["discord-webhook-url"];

// Key Vault name to application env var.
const ENV_VAR = {
  "database-url": "DATABASE_URL",
  "geoapify-api-key": "GEOAPIFY_API_KEY",
  "discord-webhook-url": "DISCORD_WEBHOOK_URL",
};

async function loadSecrets() {
  const secrets = {};
  const wanted = [...REQUIRED_SECRETS, ...OPTIONAL_SECRETS];

  // Only contact Key Vault for values that are not already set.
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
