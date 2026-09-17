const request = require("supertest");
const { createApp, prisma, setUser, resetMocks } = require("./testApp");

const app = createApp();

beforeEach(() => {
  resetMocks();
});

// Real file headers — the routes trust the bytes, not the Content-Type header.
const JPEG = Buffer.concat([Buffer.from("ffd8ffe000104a464946", "hex"), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64, 1)]);
const NOT_AN_IMAGE = Buffer.concat([Buffer.from("<?php echo 1; ?>"), Buffer.alloc(64, 1)]);

const ownEvent = { id: 7, organizerId: 2, title: "Tech Talk", status: "PUBLISHED" };

const upload = (body, type = "image/jpeg") =>
  request(app).post("/events/api/events/7/image").set("Content-Type", type).send(body);

describe("POST /events/api/events/:id/image", () => {
  test("stores the image and returns a URL carrying a fresh key", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue(ownEvent);
    prisma.eventImage.upsert.mockResolvedValue({});

    const res = await upload(JPEG);

    expect(res.status).toBe(201);
    expect(res.body.imageUrl).toMatch(/^\/events\/api\/events\/7\/image\/[0-9a-f]{24}$/);
    expect(prisma.eventImage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventId: 7 },
        update: expect.objectContaining({ mimeType: "image/jpeg" }),
      })
    );
    // The bytes that went in are the bytes that came off the wire.
    expect(prisma.eventImage.upsert.mock.calls[0][0].create.bytes.equals(JPEG)).toBe(true);
  });

  test("a replacement gets a different key, so caches can't serve the old image", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue(ownEvent);
    prisma.eventImage.upsert.mockResolvedValue({});

    const first = await upload(JPEG);
    const second = await upload(PNG, "image/png");

    expect(second.status).toBe(201);
    expect(second.body.imageUrl).not.toBe(first.body.imageUrl);
  });

  test("rejects a file whose bytes aren't an image, whatever the Content-Type says", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue(ownEvent);

    const res = await upload(NOT_AN_IMAGE);

    expect(res.status).toBe(400);
    expect(prisma.eventImage.upsert).not.toHaveBeenCalled();
  });

  test("another organizer can't put an image on someone else's event", async () => {
    setUser({ id: 99, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue(ownEvent);

    const res = await upload(JPEG);

    expect(res.status).toBe(403);
    expect(prisma.eventImage.upsert).not.toHaveBeenCalled();
  });

  test("a student can't upload at all", async () => {
    setUser({ id: 3, role: "STUDENT" });

    const res = await upload(JPEG);

    expect(res.status).toBe(403);
  });

  test("an admin can upload to an event they don't own", async () => {
    setUser({ id: 1, role: "ADMIN" });
    prisma.event.findUnique.mockResolvedValue(ownEvent);
    prisma.eventImage.upsert.mockResolvedValue({});

    expect((await upload(JPEG)).status).toBe(201);
  });

  test("404s for an event that doesn't exist", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue(null);

    expect((await upload(JPEG)).status).toBe(404);
  });
});

describe("GET /events/api/events/:id/image/:key", () => {
  test("serves the bytes without a token — an <img> tag can't send one", async () => {
    // Prisma returns `Bytes` as a Uint8Array, not a Buffer — res.send() would JSON-encode
    // that, so the mock returns what the real client returns.
    prisma.eventImage.findUnique.mockResolvedValue({
      eventId: 7, key: "0123456789abcdef01234567", mimeType: "image/png", bytes: new Uint8Array(PNG),
    });

    const res = await request(app).get("/events/api/events/7/image/0123456789abcdef01234567");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["cache-control"]).toContain("immutable");
    // helmet's global same-origin default would block the image whenever the API isn't
    // the page's own origin (npm run dev, the e2e build).
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(res.body.equals(PNG)).toBe(true);
  });

  test("the key is what grants access: a wrong one is a 404", async () => {
    prisma.eventImage.findUnique.mockResolvedValue(null);

    expect((await request(app).get("/events/api/events/7/image/ffffffffffffffffffffffff")).status).toBe(404);
  });

  test("a key that can't be a real one is turned away before the database", async () => {
    const res = await request(app).get("/events/api/events/7/image/guessed");

    expect(res.status).toBe(404);
    expect(prisma.eventImage.findUnique).not.toHaveBeenCalled();
  });

  test("a valid key belonging to a different event doesn't work", async () => {
    prisma.eventImage.findUnique.mockResolvedValue({ eventId: 8, key: "0123456789abcdef01234567", mimeType: "image/png", bytes: new Uint8Array(PNG) });

    expect((await request(app).get("/events/api/events/7/image/0123456789abcdef01234567")).status).toBe(404);
  });
});

describe("DELETE /events/api/events/:id/image", () => {
  test("removes the organizer's own cover image", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue(ownEvent);
    prisma.eventImage.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app).delete("/events/api/events/7/image");

    expect(res.status).toBe(200);
    expect(res.body.imageUrl).toBeNull();
    expect(prisma.eventImage.deleteMany).toHaveBeenCalledWith({ where: { eventId: 7 } });
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  test("removing an image that was never there is a no-op, not an error", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue(ownEvent);
    prisma.eventImage.deleteMany.mockResolvedValue({ count: 0 });

    expect((await request(app).delete("/events/api/events/7/image")).status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test("another organizer can't remove someone else's image", async () => {
    setUser({ id: 99, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue(ownEvent);

    expect((await request(app).delete("/events/api/events/7/image")).status).toBe(403);
    expect(prisma.eventImage.deleteMany).not.toHaveBeenCalled();
  });
});

describe("events carry an imageUrl", () => {
  test("browsing published events turns the stored key into a URL", async () => {
    setUser({ id: 3, role: "STUDENT" });
    prisma.event.findMany.mockResolvedValue([
      { id: 7, title: "With poster", image: { key: "deadbeef" } },
      { id: 8, title: "Without", image: null },
    ]);

    const res = await request(app).get("/events/api/events");

    expect(res.body[0].imageUrl).toBe("/events/api/events/7/image/deadbeef");
    expect(res.body[1].imageUrl).toBeNull();
    // The key is an implementation detail; only the URL goes out.
    expect(res.body[0].image).toBeUndefined();
  });
});
