const { resolveRole } = require("../../src/middleware/auth");

// The DB model allows exactly one role per user, but a token's `roles` claim is an
// array — ADMIN beats ORGANIZER beats STUDENT when more than one is assigned
// (CLAUDE.md §4). This is exactly the logic that caused the "Insufficient role" 403
// surprise during real-token testing when one account held all three roles.
describe("resolveRole", () => {
  test("ADMIN wins when all three roles are present", () => {
    expect(resolveRole(["ADMIN", "ORGANIZER", "STUDENT"])).toBe("ADMIN");
  });

  test("ORGANIZER wins over STUDENT when ADMIN is absent", () => {
    expect(resolveRole(["ORGANIZER", "STUDENT"])).toBe("ORGANIZER");
  });

  test("returns the single role when only one is present", () => {
    expect(resolveRole(["STUDENT"])).toBe("STUDENT");
  });

  test("defaults to STUDENT when roles is empty", () => {
    expect(resolveRole([])).toBe("STUDENT");
  });

  test("defaults to STUDENT when roles is undefined (matches schema's @default(STUDENT))", () => {
    expect(resolveRole(undefined)).toBe("STUDENT");
  });

  test("order in the input array doesn't matter — priority always wins", () => {
    expect(resolveRole(["STUDENT", "ADMIN"])).toBe("ADMIN");
  });
});
