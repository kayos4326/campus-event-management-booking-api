const request = require("supertest");
const { createApp, prisma, setUser, resetMocks } = require("./testApp");

const app = createApp();

beforeEach(() => resetMocks());

describe("POST /events/api/bookings", () => {
  test("CONFIRMED when the event has room", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.event.findUnique.mockResolvedValue({
      id: 1,
      status: "PUBLISHED",
      capacity: 10,
      _count: { bookings: 3 },
    });
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
    prisma.event.findUnique.mockResolvedValue({
      id: 2,
      status: "PUBLISHED",
      capacity: 1,
      _count: { bookings: 1 },
    });
    prisma.booking.create.mockResolvedValue({ id: 2, eventId: 2, studentId: 5, status: "WAITLISTED" });

    const res = await request(app)
      .post("/events/api/bookings")
      .send({ eventId: 2 });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("WAITLISTED");
  });

  test("404 when the event doesn't exist or isn't published", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.event.findUnique.mockResolvedValue(null);

    const res = await request(app).post("/events/api/bookings").send({ eventId: 999 });

    expect(res.status).toBe(404);
  });

  test("400 when eventId is missing", async () => {
    setUser({ id: 5, role: "STUDENT" });

    const res = await request(app).post("/events/api/bookings").send({});

    expect(res.status).toBe(400);
  });

  // Regression test for a real bug (CLAUDE.md §4): the DB's unique constraint on
  // [eventId, studentId] was firing correctly, but surfaced as a generic 500 because
  // the P2002 error wasn't caught — confirmed by actually double-booking via HTTP.
  test("409 with a clear message on a duplicate booking (P2002)", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.event.findUnique.mockResolvedValue({
      id: 1,
      status: "PUBLISHED",
      capacity: 10,
      _count: { bookings: 0 },
    });
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    prisma.booking.create.mockRejectedValue(p2002);

    const res = await request(app).post("/events/api/bookings").send({ eventId: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already booked/i);
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
    prisma.booking.findUnique.mockResolvedValue({ id: 1, studentId: 5, status: "CONFIRMED" });
    prisma.booking.update.mockResolvedValue({ id: 1, studentId: 5, status: "CANCELLED" });

    const res = await request(app).patch("/events/api/bookings/1/cancel");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");
  });

  // Regression test: verified for real that cancelling someone else's booking returns
  // 404 (not 403), so the endpoint doesn't leak whether a booking id belongs to someone.
  test("404 (not 403) when trying to cancel someone else's booking", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.booking.findUnique.mockResolvedValue({ id: 1, studentId: 999, status: "CONFIRMED" });

    const res = await request(app).patch("/events/api/bookings/1/cancel");

    expect(res.status).toBe(404);
  });

  test("404 when the booking doesn't exist", async () => {
    setUser({ id: 5, role: "STUDENT" });
    prisma.booking.findUnique.mockResolvedValue(null);

    const res = await request(app).patch("/events/api/bookings/1/cancel");

    expect(res.status).toBe(404);
  });
});
