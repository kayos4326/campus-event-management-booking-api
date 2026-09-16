const mockGetSecret = jest.fn(); // jest.mock factories may only use `mock…` names
jest.mock("@azure/identity", () => ({ DefaultAzureCredential: jest.fn() }));
jest.mock("@azure/keyvault-secrets", () => ({ SecretClient: jest.fn(() => ({ getSecret: mockGetSecret })) }));

const { SecretClient } = require("@azure/keyvault-secrets");
const { loadSecrets } = require("../../src/config/keyvault");

const SECRET_VARS = ["DATABASE_URL", "GEOAPIFY_API_KEY", "DISCORD_WEBHOOK_URL", "KEY_VAULT_URL"];

beforeEach(() => {
  jest.clearAllMocks();
  SECRET_VARS.forEach((v) => delete process.env[v]);
});

describe("loadSecrets", () => {
  test("reads everything from Key Vault when the environment has nothing (production)", async () => {
    process.env.KEY_VAULT_URL = "https://vault.test/";
    mockGetSecret.mockImplementation(async (name) => ({ value: `${name}-value` }));

    await loadSecrets();

    expect(process.env.DATABASE_URL).toBe("database-url-value");
    expect(process.env.GEOAPIFY_API_KEY).toBe("geoapify-api-key-value");
    expect(mockGetSecret).toHaveBeenCalledTimes(3);
  });

  // How `docker compose up` works on a laptop: no managed identity to authenticate with.
  test("uses secrets already in the environment and never contacts the vault", async () => {
    process.env.DATABASE_URL = "mysql://local";
    process.env.GEOAPIFY_API_KEY = "local-key";
    process.env.DISCORD_WEBHOOK_URL = "https://discord.local/hook";

    await loadSecrets();

    expect(SecretClient).not.toHaveBeenCalled();
    expect(process.env.DATABASE_URL).toBe("mysql://local");
  });

  test("fetches only what the environment is missing", async () => {
    process.env.KEY_VAULT_URL = "https://vault.test/";
    process.env.DATABASE_URL = "mysql://local";
    mockGetSecret.mockImplementation(async (name) => ({ value: `${name}-value` }));

    await loadSecrets();

    expect(mockGetSecret.mock.calls.map((c) => c[0])).toEqual(["geoapify-api-key", "discord-webhook-url"]);
    expect(process.env.DATABASE_URL).toBe("mysql://local"); // not overwritten
  });

  test("a missing optional secret is a warning, not a crash", async () => {
    process.env.KEY_VAULT_URL = "https://vault.test/";
    mockGetSecret.mockImplementation(async (name) => {
      if (name === "discord-webhook-url") throw new Error("not found");
      return { value: `${name}-value` };
    });

    await expect(loadSecrets()).resolves.toBeDefined();
    expect(process.env.DISCORD_WEBHOOK_URL).toBeUndefined();
  });

  test("refuses to start when a required secret is nowhere to be found", async () => {
    process.env.GEOAPIFY_API_KEY = "local-key";

    await expect(loadSecrets()).rejects.toThrow(/DATABASE_URL/);
  });
});
