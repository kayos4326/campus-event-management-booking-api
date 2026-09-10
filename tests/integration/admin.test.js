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

describe("DELETE /events/api/admin/api-keys/:id", () => {
  test("revokes (deactivates) rather than deleting the row", async () => {
    setUser({ id: 1, role: "ADMIN" });
    prisma.apiKey.update.mockResolvedValue({ id: 1, isActive: false });

    const res = await request(app).delete("/events/api/admin/api-keys/1");

    expect(res.status).toBe(200);
    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { isActive: false },
    });
  });
});
