const request = require("supertest");
const { createApp, prisma, sendSupplyRequest, setUser, resetMocks } = require("./testApp");

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

// Stands in for the database: the created event comes back as written, with its nested
// supply order (if any) the way `include: { preorder: true }` returns it.
const createReturnsWhatWasWritten = (id, extra = {}) =>
  prisma.event.create.mockImplementation(async ({ data }) => {
    const { preorder, ...event } = data;
    return { id, ...event, ...extra, preorder: preorder ? { id: 1, eventId: id, ...preorder.create } : null };
  });

const writtenSupply = () => prisma.event.create.mock.calls[0][0].data.preorder?.create;

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

  // Verified for real end-to-end: attaching supplies posts them to Discord (CLAUDE.md §5)
  // — here we just confirm the trigger fires, since the HTTP call itself is mocked out.
  // Replaced the old fixed "50 lanyards" flag on 2026-09-16: organizers choose both.
  test("orders the supplies the organizer asked for", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    createReturnsWhatWasWritten(3);

    const res = await request(app)
      .post("/events/api/events")
      .send({ ...validEventBody, status: "PUBLISHED", supply: { item: "  Water bottles ", quantity: 120 } });

    expect(res.status).toBe(201);
    expect(writtenSupply()).toEqual({ item: "Water bottles", quantity: 120, status: "PENDING" });
    expect(sendSupplyRequest).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));
    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isLargeConference: true }) })
    );
    // The response is the event itself; the order isn't mixed into it.
    expect(res.body.preorder).toBeUndefined();
  });

  // A separate second insert could fail after the event was already saved, leaving an
  // event flagged as having supplies with no order — and a 500 that invited a retry.
  test("the event and its supply order are written together, in one transaction", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    createReturnsWhatWasWritten(3);

    await request(app)
      .post("/events/api/events")
      .send({ ...validEventBody, supply: { item: "Lanyards", quantity: 40 } });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.event.create).toHaveBeenCalledTimes(1);
    expect(writtenSupply()).toEqual({ item: "Lanyards", quantity: 40, status: "PENDING" });
  });

  test("if that write fails, nothing is logged or ordered and the organizer gets an error", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.create.mockRejectedValue(new Error("deadlock"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/events/api/events")
      .send({ ...validEventBody, status: "PUBLISHED", supply: { item: "Lanyards", quantity: 40 } });

    expect(res.status).toBe(500);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(sendSupplyRequest).not.toHaveBeenCalled();
    console.error.mockRestore();
  });

  test("an amount left empty means one per seat", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    createReturnsWhatWasWritten(3);

    await request(app)
      .post("/events/api/events")
      .send({ ...validEventBody, capacity: 250, supply: { item: "Blank lanyards" } });

    expect(writtenSupply()).toEqual({ item: "Blank lanyards", quantity: 250, status: "PENDING" });
  });

  test.each([
    ["no item name", { quantity: 50 }, /say what to order/i],
    ["a blank item name", { item: "   ", quantity: 50 }, /say what to order/i],
    ["a fractional amount", { item: "Lanyards", quantity: 2.5 }, /whole number/i],
    ["a zero amount", { item: "Lanyards", quantity: 0 }, /whole number/i],
    ["an absurd amount", { item: "Lanyards", quantity: 500000 }, /whole number/i],
  ])("400 for a supply request with %s", async (_name, supply, message) => {
    setUser({ id: 2, role: "ORGANIZER" });

    const res = await request(app).post("/events/api/events").send({ ...validEventBody, supply });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(prisma.event.create).not.toHaveBeenCalled();
  });

  // Ordering supplies for a draft would mean ordering for an event nobody can book yet.
  test("a draft records the supply order but doesn't send it until it's published", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    createReturnsWhatWasWritten(9);

    await request(app)
      .post("/events/api/events")
      .send({ ...validEventBody, status: "DRAFT", supply: { item: "Lanyards", quantity: 40 } });

    expect(writtenSupply()).toEqual({ item: "Lanyards", quantity: 40, status: "PENDING" });
    expect(sendSupplyRequest).not.toHaveBeenCalled();
  });

  test("no supplies requested → nothing ordered and the event isn't flagged", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    createReturnsWhatWasWritten(4);

    await request(app).post("/events/api/events").send(validEventBody);

    expect(writtenSupply()).toBeUndefined();
    expect(sendSupplyRequest).not.toHaveBeenCalled();
    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isLargeConference: false }) })
    );
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

  test("publishing a draft sends its pending supply order", async () => {
    prisma.event.findUnique.mockResolvedValue(existingEvent({ status: "DRAFT", isLargeConference: true }));
    const published = existingEvent({ status: "PUBLISHED", isLargeConference: true })
    prisma.event.update.mockResolvedValue(published);

    const res = await request(app).patch("/events/api/events/1").send({ status: "PUBLISHED" });

    expect(res.status).toBe(200);
    expect(sendSupplyRequest).toHaveBeenCalledWith(published);
  });

  test("editing an already-published event doesn't re-send its supply order", async () => {
    prisma.event.findUnique.mockResolvedValue(existingEvent({ status: "PUBLISHED", isLargeConference: true }));
    prisma.event.update.mockResolvedValue(existingEvent({ status: "PUBLISHED", isLargeConference: true, title: "New" }));

    await request(app).patch("/events/api/events/1").send({ title: "New" });

    expect(sendSupplyRequest).not.toHaveBeenCalled();
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
      { id: 1, capacity: 5, seats: { confirmed: 5, waitlisted: 2 }, imageUrl: null },
      { id: 2, capacity: 3, seats: { confirmed: 0, waitlisted: 0 }, imageUrl: null },
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

  test("organizers get their supply order with their own events; the public list doesn't", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findMany.mockResolvedValue([]);

    await request(app).get("/events/api/events?mine=true");
    expect(prisma.event.findMany.mock.calls[0][0].include.preorder).toBe(true);

    await request(app).get("/events/api/events");
    expect(prisma.event.findMany.mock.calls[1][0].include.preorder).toBeUndefined();
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
