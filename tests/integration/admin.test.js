const request = require("supertest");
const { createApp, prisma, setUser, resetMocks } = require("./testApp");

const app = createApp();

beforeEach(() => resetMocks());

describe("Admin routes are gated to ADMIN only", () => {
  test.each(["STUDENT", "ORGANIZER"])("403 for a %s", async (role) => {
    setUser({ id: 5, role });

    const res = await request(app).get("/events/api/admin/users");

    expect(res.status).toBe(403);
  });

  test("200 for ADMIN", async () => {
    setUser({ id: 1, role: "ADMIN" });
    prisma.user.findMany.mockResolvedValue([{ id: 1, role: "ADMIN" }]);

    const res = await request(app).get("/events/api/admin/users");

    expect(res.status).toBe(200);
  });
});

describe("PATCH /events/api/admin/users/:id/role", () => {
  test("rejects an invalid role value", async () => {
    setUser({ id: 1, role: "ADMIN" });

    const res = await request(app)
      .patch("/events/api/admin/users/2/role")
      .send({ role: "SUPERUSER" });

    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test("accepts a valid role change", async () => {
    setUser({ id: 1, role: "ADMIN" });
    prisma.user.update.mockResolvedValue({ id: 2, role: "ORGANIZER" });

    const res = await request(app)
      .patch("/events/api/admin/users/2/role")
      .send({ role: "ORGANIZER" });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe("ORGANIZER");
  });

  // Regression test for a real lockout: an Admin demoting themselves loses access to
  // this panel immediately, with no way back through the app (happened twice).
  test.each(["STUDENT", "ORGANIZER"])("400 when an Admin tries to change their own role to %s", async (role) => {
    setUser({ id: 1, role: "ADMIN" });

    const res = await request(app)
      .patch("/events/api/admin/users/1/role")
      .send({ role });

    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test("404 (not 500) when the user id doesn't exist (Prisma P2025)", async () => {
    setUser({ id: 1, role: "ADMIN" });
    prisma.user.update.mockRejectedValue(Object.assign(new Error("Record not found"), { code: "P2025" }));

    const res = await request(app)
      .patch("/events/api/admin/users/999/role")
      .send({ role: "ORGANIZER" });

    expect(res.status).toBe(404);
  });
});

describe("POST /events/api/admin/api-keys", () => {
  test("issues a key and returns the raw value exactly once", async () => {
    setUser({ id: 1, role: "ADMIN" });
    prisma.apiKey.create.mockResolvedValue({ id: 1, ownerLabel: "test", scope: "room-status:read" });

    const res = await request(app)
      .post("/events/api/admin/api-keys")
      .send({ ownerLabel: "test", scope: "room-status:read" });

    expect(res.status).toBe(201);
    expect(res.body.key).toBeDefined();
    expect(typeof res.body.key).toBe("string");
    // Only the hash should ever be persisted — never the raw key.
    expect(prisma.apiKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerLabel: "test",
        scope: "room-status:read",
        keyHash: expect.any(String),
      }),
    });
    expect(prisma.apiKey.create.mock.calls[0][0].data.keyHash).not.toBe(res.body.key);
  });

  test("400 when ownerLabel or scope is missing", async () => {
    setUser({ id: 1, role: "ADMIN" });

    const res = await request(app).post("/events/api/admin/api-keys").send({ ownerLabel: "test" });

    expect(res.status).toBe(400);
  });
});

describe("GET /events/api/admin/api-keys", () => {
  test("lists keys newest first without ever selecting the hash", async () => {
    setUser({ id: 1, role: "ADMIN" });
    prisma.apiKey.findMany.mockResolvedValue([{ id: 2, ownerLabel: "display", isActive: true }]);

    const res = await request(app).get("/events/api/admin/api-keys");

    expect(res.status).toBe(200);
    const args = prisma.apiKey.findMany.mock.calls[0][0];
    expect(args.select.keyHash).toBeUndefined();
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });

  test("403 for a non-admin", async () => {
    setUser({ id: 5, role: "ORGANIZER" });

    const res = await request(app).get("/events/api/admin/api-keys");

    expect(res.status).toBe(403);
  });
});

describe("DELETE /events/api/admin/api-keys/:id", () => {
  test("revokes (deactivates) rather than deleting the row", async () => {
    setUser({ id: 1, role: "ADMIN" });
    prisma.apiKey.update.mockResolvedValue({ id: 1, isActive: false });

    const res = await request(app).delete("/events/api/admin/api-keys/1");

    expect(res.status).toBe(200);
    expect(prisma.apiKey.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 1 },
      data: { isActive: false },
    }));
  });

  // Found by the live-DB test run: the revoke response used to include keyHash.
  test("never selects the key hash for the response", async () => {
    setUser({ id: 1, role: "ADMIN" });
    prisma.apiKey.update.mockResolvedValue({ id: 1, isActive: false });

    await request(app).delete("/events/api/admin/api-keys/1");

    const { select } = prisma.apiKey.update.mock.calls[0][0];
    expect(select).toBeDefined();
    expect(select.keyHash).toBeUndefined();
  });
});
