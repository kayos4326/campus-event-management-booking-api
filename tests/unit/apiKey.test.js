const { hashApiKey } = require("../../src/middleware/apiKey");

describe("hashApiKey", () => {
  test("is a consistent, deterministic SHA-256 hex digest", () => {
    const hash1 = hashApiKey("my-secret-key");
    const hash2 = hashApiKey("my-secret-key");

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("different inputs produce different hashes", () => {
    expect(hashApiKey("key-a")).not.toBe(hashApiKey("key-b"));
  });
});
