const request = require("supertest");
const { createApp, prisma, preorderLanyards, setUser, resetMocks } = require("./testApp");

const app = createApp();

beforeEach(() => resetMocks());

const validEventBody = {
  title: "Tech Talk",
  startsAt: "2026-12-01T09:00:00Z",
  endsAt: "2026-12-01T11:00:00Z",
  capacity: 10,
  venueId: 1,
};

describe("POST /events/api/events", () => {
  test("creates an event for an Organizer", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.create.mockResolvedValue({ id: 1, ...validEventBody, organizerId: 2, isLargeConference: false });

    const res = await request(app).post("/events/api/events").send(validEventBody);

    expect(res.status).toBe(201);
    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ organizerId: 2 }) })
    );
  });

  // Regression test for a real bug (CLAUDE.md §4): `!capacity` treats a legitimate
  // capacity of 0 as "missing" (0 is falsy) — confirmed directly, produced a misleading
  // "Missing required event fields" error instead of a clear one about capacity.
  test("400 with a specific message when capacity is 0, not the generic 'missing fields' error", async () => {
    setUser({ id: 2, role: "ORGANIZER" });

    const res = await request(app)
      .post("/events/api/events")
      .send({ ...validEventBody, capacity: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/capacity/i);
    expect(res.body.error).not.toMatch(/missing required event fields/i);
  });

  test("400 when capacity is negative or not an integer", async () => {
    setUser({ id: 2, role: "ORGANIZER" });

    const res = await request(app)
      .post("/events/api/events")
      .send({ ...validEventBody, capacity: 1.5 });

    expect(res.status).toBe(400);
  });

  test("400 when a required field is genuinely missing", async () => {
    setUser({ id: 2, role: "ORGANIZER" });

    const res = await request(app)
      .post("/events/api/events")
      .send({ ...validEventBody, title: undefined });

    expect(res.status).toBe(400);
  });

  // Verified for real end-to-end: a large-conference event triggers a Discord webhook
  // notification (CLAUDE.md §5) — here we just confirm the trigger fires, since the
  // actual HTTP call to Discord is mocked out.
  test("triggers preorderLanyards when isLargeConference is true", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    const created = { id: 3, ...validEventBody, organizerId: 2, isLargeConference: true };
    prisma.event.create.mockResolvedValue(created);

    await request(app)
      .post("/events/api/events")
      .send({ ...validEventBody, isLargeConference: true });

    expect(preorderLanyards).toHaveBeenCalledWith(created);
  });

  test("does not trigger preorderLanyards for a normal event", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.create.mockResolvedValue({ id: 4, ...validEventBody, organizerId: 2, isLargeConference: false });

    await request(app).post("/events/api/events").send(validEventBody);

    expect(preorderLanyards).not.toHaveBeenCalled();
  });

  test("403 when a Student tries to create an event", async () => {
    setUser({ id: 5, role: "STUDENT" });

    const res = await request(app).post("/events/api/events").send(validEventBody);

    expect(res.status).toBe(403);
  });
});

describe("ownership checks on PATCH/DELETE /events/api/events/:id", () => {
  test("Organizer can update their own event", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue({ id: 1, organizerId: 2 });
    prisma.event.update.mockResolvedValue({ id: 1, organizerId: 2, title: "Updated" });

    const res = await request(app).patch("/events/api/events/1").send({ title: "Updated" });

    expect(res.status).toBe(200);
  });

  test("403 when an Organizer tries to update someone else's event", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue({ id: 1, organizerId: 999 });

    const res = await request(app).patch("/events/api/events/1").send({ title: "Hijacked" });

    expect(res.status).toBe(403);
    expect(prisma.event.update).not.toHaveBeenCalled();
  });

  test("Admin can update any event regardless of organizerId", async () => {
    setUser({ id: 1, role: "ADMIN" });
    prisma.event.findUnique.mockResolvedValue({ id: 1, organizerId: 999 });
    prisma.event.update.mockResolvedValue({ id: 1, organizerId: 999, title: "Admin edit" });

    const res = await request(app).patch("/events/api/events/1").send({ title: "Admin edit" });

    expect(res.status).toBe(200);
  });

  test("DELETE sets status to CANCELLED rather than removing the row", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue({ id: 1, organizerId: 2 });
    prisma.event.update.mockResolvedValue({ id: 1, organizerId: 2, status: "CANCELLED" });

    const res = await request(app).delete("/events/api/events/1");

    expect(res.status).toBe(200);
    expect(prisma.event.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: "CANCELLED" },
    });
  });
});

describe("GET /events/api/events", () => {
  test("defaults to only PUBLISHED events", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.event.findMany.mockResolvedValue([]);

    await request(app).get("/events/api/events");

    expect(prisma.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "PUBLISHED" } })
    );
  });

  // Added for the frontend's "My Events" panel (CLAUDE.md §9) — an Organizer needs to
  // see their own events including drafts, which the default PUBLISHED-only view hides.
  test("?mine=true returns the caller's own events regardless of status", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findMany.mockResolvedValue([]);

    await request(app).get("/events/api/events?mine=true");

    expect(prisma.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizerId: 2 } })
    );
  });
});
