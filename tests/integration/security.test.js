const request = require("supertest");

// Tight limits so the rate-limit test doesn't need hundreds of requests. Read before
// createApp() builds the limiters.
process.env.RATE_LIMIT_WRITES = "3";
process.env.RATE_LIMIT_REQUESTS = "50";

const { createApp, prisma, setUser, resetMocks } = require("./testApp");

const app = createApp();
const SITE = "https://chaotic-hell.eastasia.cloudapp.azure.com";

beforeEach(() => resetMocks());

describe("browser origins", () => {
  test("our own site is allowed", async () => {
    setUser({ id: 1, role: "STUDENT" });

    const res = await request(app).get("/events/api/me").set("Origin", SITE);

    expect(res.headers["access-control-allow-origin"]).toBe(SITE);
  });

  test("another website gets no CORS headers, so the browser blocks the response", async () => {
    setUser({ id: 1, role: "STUDENT" });

    const res = await request(app).get("/events/api/me").set("Origin", "https://evil.example.com");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("server-to-server calls (no Origin) still work — that's how the room-status API is used", async () => {
    prisma.apiKey.findFirst.mockResolvedValue({ id: 1, isActive: true });
    prisma.event.findFirst.mockResolvedValue(null);

    const res = await request(app).get("/events/api/peer/events/active?room=101").set("x-api-key", "k");

    expect(res.status).toBe(200);
  });
});

describe("security headers", () => {
  test("responses can't be framed, sniffed, or load scripts from elsewhere", async () => {
    const res = await request(app).get("/health");

    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toBeDefined();
    expect(res.headers["x-powered-by"]).toBeUndefined(); // don't advertise Express
  });

  test("the map tiles and Google Fonts the app needs are still allowed", async () => {
    const policy = (await request(app).get("/health")).headers["content-security-policy"];

    expect(policy).toContain("tile.openstreetmap.org");
    expect(policy).toContain("fonts.gstatic.com");
    expect(policy).toContain("login.microsoftonline.com");
  });
});

describe("rate limiting", () => {
  test("a burst of writes is cut off with 429, and reading still works", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.event.findUnique.mockResolvedValue({ id: 1, status: "PUBLISHED", capacity: 10 });
    prisma.booking.create.mockResolvedValue({ id: 1, status: "CONFIRMED" });
    prisma.event.findMany.mockResolvedValue([]);

    const codes = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post("/events/api/bookings").set("authorization", "Bearer burst").send({ eventId: 1 });
      codes.push(res.status);
    }

    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes[0]).not.toBe(429);
    expect(codes.at(-1)).toBe(429);
    expect((await request(app).get("/events/api/events").set("authorization", "Bearer burst")).status).toBe(200);
  });

  test("a different user is unaffected by someone else's burst", async () => {
    setUser({ id: 6, role: "STUDENT" });
    prisma.event.findUnique.mockResolvedValue({ id: 1, status: "PUBLISHED", capacity: 10 });
    prisma.booking.create.mockResolvedValue({ id: 2, status: "CONFIRMED" });

    const res = await request(app).post("/events/api/bookings").set("authorization", "Bearer someone-else").send({ eventId: 1 });

    expect(res.status).toBe(201);
  });
});
