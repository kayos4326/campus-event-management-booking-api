const request = require("supertest");
const { createApp, prisma, resetMocks } = require("./testApp");
const { hashApiKey } = require("../../src/middleware/apiKey");

const app = createApp();

beforeEach(() => resetMocks());

describe("GET /events/api/peer/events/active", () => {
  test("401 when no x-api-key header is provided", async () => {
    const res = await request(app).get("/events/api/peer/events/active?room=101");

    expect(res.status).toBe(401);
  });

  test("401 when the key doesn't match any active key in the DB", async () => {
    prisma.apiKey.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get("/events/api/peer/events/active?room=101")
      .set("x-api-key", "wrong-key");

    expect(res.status).toBe(401);
  });

  test("looks up the key by its hash, never the raw value", async () => {
    prisma.apiKey.findFirst.mockResolvedValue({ id: 1, isActive: true });
    prisma.event.findFirst.mockResolvedValue(null);

    await request(app)
      .get("/events/api/peer/events/active?room=101")
      .set("x-api-key", "my-real-key");

    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith({
      where: { keyHash: hashApiKey("my-real-key"), scope: "room-status:read", isActive: true },
    });
  });

  test("400 when room query param is missing", async () => {
    prisma.apiKey.findFirst.mockResolvedValue({ id: 1, isActive: true });

    const res = await request(app)
      .get("/events/api/peer/events/active")
      .set("x-api-key", "valid-key");

    expect(res.status).toBe(400);
  });

  test("active:false when no event is currently running in that room", async () => {
    prisma.apiKey.findFirst.mockResolvedValue({ id: 1, isActive: true });
    prisma.event.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get("/events/api/peer/events/active?room=101")
      .set("x-api-key", "valid-key");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  test("active:true with event details when one is currently running", async () => {
    prisma.apiKey.findFirst.mockResolvedValue({ id: 1, isActive: true });
    prisma.event.findFirst.mockResolvedValue({
      id: 3,
      title: "Live Now Conference",
      endsAt: "2026-09-10T16:24:46.000Z",
    });

    const res = await request(app)
      .get("/events/api/peer/events/active?room=101")
      .set("x-api-key", "valid-key");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      eventId: 3,
      title: "Live Now Conference",
      endsAt: "2026-09-10T16:24:46.000Z",
    });
  });
});
