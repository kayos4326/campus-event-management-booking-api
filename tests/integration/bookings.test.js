const request = require("supertest");
const { createApp, prisma, setUser, resetMocks } = require("./testApp");

const app = createApp();

beforeEach(() => resetMocks());

const publishedEvent = (overrides = {}) => ({ id: 1, status: "PUBLISHED", capacity: 10, ...overrides });

describe("POST /events/api/bookings", () => {
  test("CONFIRMED when the event has room", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.event.findUnique.mockResolvedValue(publishedEvent());
    prisma.booking.count.mockResolvedValue(3);
    prisma.booking.create.mockResolvedValue({ id: 1, eventId: 1, studentId: 5, status: "CONFIRMED" });

    const res = await request(app)
      .post("/events/api/bookings")
      .send({ eventId: 1 });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("CONFIRMED");
    expect(prisma.booking.create).toHaveBeenCalledWith({
      data: { eventId: 1, studentId: 5, status: "CONFIRMED" },
    });
  });

  // Regression test for a real bug (CLAUDE.md §4): originally there was no way for a
  // single test account to exercise this path since it requires a genuinely distinct
  // second user filling capacity — confirmed for real with a seeded second account.
  test("WAITLISTED when the event is already at capacity", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.event.findUnique.mockResolvedValue(publishedEvent({ id: 2, capacity: 1 }));
    prisma.booking.count.mockResolvedValue(1);
    prisma.booking.create.mockResolvedValue({ id: 2, eventId: 2, studentId: 5, status: "WAITLISTED" });

    const res = await request(app)
      .post("/events/api/bookings")
      .send({ eventId: 2 });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("WAITLISTED");
    expect(prisma.booking.create).toHaveBeenCalledWith({
      data: { eventId: 2, studentId: 5, status: "WAITLISTED" },
    });
  });

  // Two students booking the last seat at the same moment must not both get it — the
  // seat count only happens after the event row is locked, inside one transaction.
  test("locks the event row before counting seats", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.event.findUnique.mockResolvedValue(publishedEvent());
    prisma.booking.create.mockResolvedValue({ id: 1, status: "CONFIRMED" });

    await request(app).post("/events/api/bookings").send({ eventId: 1 });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const [sql, eventId] = prisma.$queryRaw.mock.calls[0];
    expect(sql.join("?")).toMatch(/FROM events WHERE id = \? FOR UPDATE/);
    expect(eventId).toBe(1);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.booking.count.mock.invocationCallOrder[0]
    );
  });

  // Regression test for a real bug: a cancelled booking's row still exists, so the
  // (eventId, studentId) unique constraint blocked ever booking that event again.
  test("rebooking after a cancel reuses the cancelled row instead of failing", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.event.findUnique.mockResolvedValue(publishedEvent());
    prisma.booking.findUnique.mockResolvedValue({ id: 7, eventId: 1, studentId: 5, status: "CANCELLED" });
    prisma.booking.update.mockResolvedValue({ id: 7, eventId: 1, studentId: 5, status: "CONFIRMED" });

    const res = await request(app).post("/events/api/bookings").send({ eventId: 1 });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("CONFIRMED");
    expect(prisma.booking.create).not.toHaveBeenCalled();
    expect(prisma.booking.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { status: "CONFIRMED", createdAt: expect.any(Date) },
    });
  });

  test("rebooking a full event puts you at the back of the waitlist", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.event.findUnique.mockResolvedValue(publishedEvent({ capacity: 2 }));
    prisma.booking.count.mockResolvedValue(2);
    prisma.booking.findUnique.mockResolvedValue({ id: 7, eventId: 1, studentId: 5, status: "CANCELLED" });
    prisma.booking.update.mockResolvedValue({ id: 7, status: "WAITLISTED" });

    const res = await request(app).post("/events/api/bookings").send({ eventId: 1 });

    expect(res.status).toBe(201);
    expect(prisma.booking.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { status: "WAITLISTED", createdAt: expect.any(Date) },
    });
  });

  test("409 when the student already has an active booking", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.event.findUnique.mockResolvedValue(publishedEvent());
    prisma.booking.findUnique.mockResolvedValue({ id: 7, eventId: 1, studentId: 5, status: "WAITLISTED" });

    const res = await request(app).post("/events/api/bookings").send({ eventId: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already booked/i);
    expect(prisma.booking.create).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test("404 when the event doesn't exist", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.event.findUnique.mockResolvedValue(null);

    const res = await request(app).post("/events/api/bookings").send({ eventId: 999 });

    expect(res.status).toBe(404);
  });

  test("404 when the event isn't published (draft or cancelled)", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.event.findUnique.mockResolvedValue(publishedEvent({ status: "CANCELLED" }));

    const res = await request(app).post("/events/api/bookings").send({ eventId: 1 });

    expect(res.status).toBe(404);
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  test("400 when eventId is missing", async () => {
    setUser({ id: 5, role: "STUDENT" });

    const res = await request(app).post("/events/api/bookings").send({});

    expect(res.status).toBe(400);
  });

  test("404 (not 500) when eventId isn't a number", async () => {
    setUser({ id: 5, role: "STUDENT" });

    const res = await request(app).post("/events/api/bookings").send({ eventId: "abc" });

    expect(res.status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // Regression test for a real bug (CLAUDE.md §4): the DB's unique constraint on
  // [eventId, studentId] was firing correctly, but surfaced as a generic 500 because
  // the P2002 error wasn't caught — confirmed by actually double-booking via HTTP.
  test("409 with a clear message on a duplicate booking (P2002)", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.event.findUnique.mockResolvedValue(publishedEvent());
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    prisma.booking.create.mockRejectedValue(p2002);

    const res = await request(app).post("/events/api/bookings").send({ eventId: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already booked/i);
  });

  test("400 (not 500) on a malformed JSON body", async () => {
    setUser({ id: 5, role: "STUDENT" });

    const res = await request(app)
      .post("/events/api/bookings")
      .set("Content-Type", "application/json")
      .send("{not json");

    expect(res.status).toBe(400);
  });

  test("403 when the caller isn't a Student (e.g. an Organizer trying to book)", async () => {
    setUser({ id: 5, role: "ORGANIZER" });

    const res = await request(app).post("/events/api/bookings").send({ eventId: 1 });

    expect(res.status).toBe(403);
  });

  test("401 with no authenticated user at all", async () => {
    setUser(null);

    const res = await request(app).post("/events/api/bookings").send({ eventId: 1 });

    expect(res.status).toBe(401);
  });
});

describe("PATCH /events/api/bookings/:id/cancel", () => {
  test("cancels the caller's own booking", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.booking.findUnique.mockResolvedValue({ id: 1, eventId: 1, studentId: 5, status: "WAITLISTED" });
    prisma.booking.update.mockResolvedValue({ id: 1, studentId: 5, status: "CANCELLED" });

    const res = await request(app).patch("/events/api/bookings/1/cancel");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");
    // A waitlisted booking never held a seat, so nobody gets promoted.
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  // Regression test for a real gap: cancelling a confirmed seat used to leave everyone
  // on the waitlist stuck there forever.
  test("cancelling a CONFIRMED booking promotes the oldest waitlisted booking", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.booking.findUnique.mockResolvedValue({ id: 1, eventId: 3, studentId: 5, status: "CONFIRMED" });
    prisma.booking.update.mockResolvedValue({ id: 1, eventId: 3, studentId: 5, status: "CANCELLED" });
    prisma.event.findUnique.mockResolvedValue({ id: 3, status: "PUBLISHED", capacity: 2 });
    prisma.booking.count.mockResolvedValue(1); // one seat now open
    prisma.booking.findMany.mockResolvedValue([{ id: 42 }]);

    const res = await request(app).patch("/events/api/bookings/1/cancel");

    expect(res.status).toBe(200);
    expect(prisma.booking.findMany).toHaveBeenCalledWith({
      where: { eventId: 3, status: "WAITLISTED" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 1,
      select: { id: true },
    });
    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [42] } },
      data: { status: "CONFIRMED" },
    });
  });

  test("no promotion while the event is unpublished (back in DRAFT)", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.booking.findUnique.mockResolvedValue({ id: 1, eventId: 3, studentId: 5, status: "CONFIRMED" });
    prisma.booking.update.mockResolvedValue({ id: 1, status: "CANCELLED" });
    prisma.event.findUnique.mockResolvedValue({ id: 3, status: "DRAFT", capacity: 2 });

    const res = await request(app).patch("/events/api/bookings/1/cancel");

    expect(res.status).toBe(200);
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  test("cancelling an already-cancelled booking is a no-op", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.booking.findUnique.mockResolvedValue({ id: 1, eventId: 3, studentId: 5, status: "CANCELLED" });

    const res = await request(app).patch("/events/api/bookings/1/cancel");

    expect(res.status).toBe(200);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  // Regression test: verified for real that cancelling someone else's booking returns
  // 404 (not 403), so the endpoint doesn't leak whether a booking id belongs to someone.
  test("404 (not 403) when trying to cancel someone else's booking", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.booking.findUnique.mockResolvedValue({ id: 1, eventId: 1, studentId: 999, status: "CONFIRMED" });

    const res = await request(app).patch("/events/api/bookings/1/cancel");

    expect(res.status).toBe(404);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test("404 when the booking doesn't exist", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.booking.findUnique.mockResolvedValue(null);

    const res = await request(app).patch("/events/api/bookings/1/cancel");

    expect(res.status).toBe(404);
  });
});
