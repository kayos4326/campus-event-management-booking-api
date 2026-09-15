const request = require("supertest");
const { createApp, prisma, preorderLanyards, setUser, resetMocks } = require("./testApp");

const app = createApp();

beforeEach(() => {
  resetMocks();
  prisma.venue.findUnique.mockResolvedValue({ id: 1, name: "Hall" });
});

const validEventBody = {
  title: "Tech Talk",
  startsAt: "2026-12-01T09:00:00Z",
  endsAt: "2026-12-01T11:00:00Z",
  capacity: 10,
  venueId: 1,
};

const existingEvent = (overrides = {}) => ({
  id: 1,
  organizerId: 2,
  status: "PUBLISHED",
  capacity: 10,
  startsAt: new Date("2026-12-01T09:00:00Z"),
  endsAt: new Date("2026-12-01T11:00:00Z"),
  ...overrides,
});

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

  test("400 when the event ends before it starts", async () => {
    setUser({ id: 2, role: "ORGANIZER" });

    const res = await request(app)
      .post("/events/api/events")
      .send({ ...validEventBody, endsAt: "2026-12-01T08:00:00Z" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must end after it starts/);
    expect(prisma.event.create).not.toHaveBeenCalled();
  });

  test("400 (not 500) when a date isn't a real date", async () => {
    setUser({ id: 2, role: "ORGANIZER" });

    const res = await request(app)
      .post("/events/api/events")
      .send({ ...validEventBody, startsAt: "next tuesday-ish" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/start time/i);
  });

  test("400 (not 500) when venueId doesn't match a venue", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.venue.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post("/events/api/events")
      .send({ ...validEventBody, venueId: 999 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/venue/i);
    expect(prisma.event.create).not.toHaveBeenCalled();
  });

  test("400 for a status other than DRAFT or PUBLISHED", async () => {
    setUser({ id: 2, role: "ORGANIZER" });

    const res = await request(app)
      .post("/events/api/events")
      .send({ ...validEventBody, status: "LIVE" });

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
    prisma.event.findUnique.mockResolvedValue(existingEvent());
    prisma.event.update.mockResolvedValue(existingEvent({ title: "Updated" }));

    const res = await request(app).patch("/events/api/events/1").send({ title: "Updated" });

    expect(res.status).toBe(200);
  });

  test("403 when an Organizer tries to update someone else's event", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue(existingEvent({ organizerId: 999 }));

    const res = await request(app).patch("/events/api/events/1").send({ title: "Hijacked" });

    expect(res.status).toBe(403);
    expect(prisma.event.update).not.toHaveBeenCalled();
  });

  test("Admin can update any event regardless of organizerId", async () => {
    setUser({ id: 1, role: "ADMIN" });
    prisma.event.findUnique.mockResolvedValue(existingEvent({ organizerId: 999 }));
    prisma.event.update.mockResolvedValue(existingEvent({ organizerId: 999, title: "Admin edit" }));

    const res = await request(app).patch("/events/api/events/1").send({ title: "Admin edit" });

    expect(res.status).toBe(200);
  });

  test("404 (not 500) for a non-numeric event id", async () => {
    setUser({ id: 2, role: "ORGANIZER" });

    const res = await request(app).patch("/events/api/events/abc").send({ title: "x" });

    expect(res.status).toBe(404);
  });

  test("DELETE sets status to CANCELLED rather than removing the row", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue(existingEvent());
    prisma.event.update.mockResolvedValue(existingEvent({ status: "CANCELLED" }));

    const res = await request(app).delete("/events/api/events/1");

    expect(res.status).toBe(200);
    expect(prisma.event.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: "CANCELLED" },
    });
  });

  // Regression test for a real gap: cancelling an event used to leave its bookings
  // showing CONFIRMED.
  test("DELETE also cancels the event's confirmed and waitlisted bookings", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue(existingEvent());
    prisma.event.update.mockResolvedValue(existingEvent({ status: "CANCELLED" }));

    await request(app).delete("/events/api/events/1");

    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { eventId: 1, status: { in: ["CONFIRMED", "WAITLISTED"] } },
      data: { status: "CANCELLED" },
    });
  });

  test("DELETE on someone else's event is 403 and touches no bookings", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue(existingEvent({ organizerId: 999 }));

    const res = await request(app).delete("/events/api/events/1");

    expect(res.status).toBe(403);
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });
});

describe("PATCH /events/api/events/:id validation and seat bookkeeping", () => {
  beforeEach(() => setUser({ id: 2, role: "ORGANIZER" }));

  test.each([
    [{ capacity: 0 }, /capacity/i],
    [{ capacity: "abc" }, /capacity/i],
    [{ status: "LIVE" }, /status/i],
    [{ title: "" }, /title/i],
    [{ startsAt: "not a date" }, /start time/i],
  ])("400 for invalid input %p", async (body, message) => {
    const res = await request(app).patch("/events/api/events/1").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(prisma.event.update).not.toHaveBeenCalled();
  });

  test("400 when the new end time is before the existing start time", async () => {
    prisma.event.findUnique.mockResolvedValue(existingEvent());

    const res = await request(app)
      .patch("/events/api/events/1")
      .send({ endsAt: "2026-12-01T08:00:00Z" });

    expect(res.status).toBe(400);
    expect(prisma.event.update).not.toHaveBeenCalled();
  });

  test("409 when lowering capacity below the seats already confirmed", async () => {
    prisma.event.findUnique.mockResolvedValue(existingEvent({ capacity: 10 }));
    prisma.booking.count.mockResolvedValue(6);

    const res = await request(app).patch("/events/api/events/1").send({ capacity: 5 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/6 seats already confirmed/);
    expect(prisma.event.update).not.toHaveBeenCalled();
  });

  test("lowering capacity to exactly the confirmed count is allowed", async () => {
    prisma.event.findUnique.mockResolvedValue(existingEvent({ capacity: 10 }));
    prisma.booking.count.mockResolvedValue(5);
    prisma.event.update.mockResolvedValue(existingEvent({ capacity: 5 }));

    const res = await request(app).patch("/events/api/events/1").send({ capacity: 5 });

    expect(res.status).toBe(200);
  });

  test("raising capacity promotes waitlisted bookings into the new seats", async () => {
    prisma.event.findUnique.mockResolvedValue(existingEvent({ capacity: 2 }));
    prisma.event.update.mockResolvedValue(existingEvent({ capacity: 4 }));
    prisma.booking.count.mockResolvedValue(2); // 2 new seats open
    prisma.booking.findMany.mockResolvedValue([{ id: 11 }, { id: 12 }]);

    const res = await request(app).patch("/events/api/events/1").send({ capacity: 4 });

    expect(res.status).toBe(200);
    expect(prisma.booking.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [11, 12] } },
      data: { status: "CONFIRMED" },
    });
  });

  test("setting status to CANCELLED via PATCH cancels bookings too", async () => {
    prisma.event.findUnique.mockResolvedValue(existingEvent());
    prisma.event.update.mockResolvedValue(existingEvent({ status: "CANCELLED" }));

    const res = await request(app).patch("/events/api/events/1").send({ status: "CANCELLED" });

    expect(res.status).toBe(200);
    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { eventId: 1, status: { in: ["CONFIRMED", "WAITLISTED"] } },
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

  test("each event carries confirmed/waitlisted seat counts from one grouped query", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.event.findMany.mockResolvedValue([
      { id: 1, capacity: 5 },
      { id: 2, capacity: 3 },
    ]);
    prisma.booking.groupBy.mockResolvedValue([
      { eventId: 1, status: "CONFIRMED", _count: { _all: 5 } },
      { eventId: 1, status: "WAITLISTED", _count: { _all: 2 } },
    ]);

    const res = await request(app).get("/events/api/events");

    expect(prisma.booking.groupBy).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual([
      { id: 1, capacity: 5, seats: { confirmed: 5, waitlisted: 2 } },
      { id: 2, capacity: 3, seats: { confirmed: 0, waitlisted: 0 } },
    ]);
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

describe("GET /events/api/events/:id", () => {
  // Regression test for a real gap: any logged-in user could read a draft by id.
  test("404 for someone else's DRAFT event", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.event.findUnique.mockResolvedValue(existingEvent({ status: "DRAFT", organizerId: 2 }));

    const res = await request(app).get("/events/api/events/1");

    expect(res.status).toBe(404);
  });

  test("the organizer can still see their own draft", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue(existingEvent({ status: "DRAFT", organizerId: 2 }));

    const res = await request(app).get("/events/api/events/1");

    expect(res.status).toBe(200);
  });

  test("an Admin can see any draft", async () => {
    setUser({ id: 1, role: "ADMIN" });
    prisma.event.findUnique.mockResolvedValue(existingEvent({ status: "DRAFT", organizerId: 2 }));

    const res = await request(app).get("/events/api/events/1");

    expect(res.status).toBe(200);
  });

  test("anyone logged in can see a PUBLISHED event", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.event.findUnique.mockResolvedValue(existingEvent());

    const res = await request(app).get("/events/api/events/1");

    expect(res.status).toBe(200);
  });
});
