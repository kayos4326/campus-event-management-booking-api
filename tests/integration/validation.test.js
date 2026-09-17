const request = require("supertest");
const { createApp, prisma, setUser, resetMocks } = require("./testApp");

const app = createApp();

beforeEach(() => {
  resetMocks();
  prisma.venue.findUnique.mockResolvedValue({ id: 1, name: "Hall" });
});

const validEvent = {
  title: "Tech Talk",
  startsAt: "2026-12-01T09:00:00Z",
  endsAt: "2026-12-01T11:00:00Z",
  capacity: 10,
  venueId: 1,
};

describe("one response shape for bad input", () => {
  test("a readable `error` for people, and `details` for every problem found", async () => {
    setUser({ id: 2, role: "ORGANIZER" });

    const res = await request(app)
      .post("/events/api/events")
      .send({ ...validEvent, capacity: 0, startsAt: "soon" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Start time must be a valid date");
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        { field: "startsAt", message: "Start time must be a valid date" },
        { field: "capacity", message: "Capacity must be a whole number of at least 1" },
      ])
    );
    expect(prisma.event.create).not.toHaveBeenCalled();
  });

  test("a JSON array instead of an object is rejected, not half-read", async () => {
    setUser({ id: 2, role: "ORGANIZER" });

    const res = await request(app).post("/events/api/events").send([validEvent]);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/JSON object/);
  });

  test("the same query parameter twice is a 400, not a crash", async () => {
    setUser({ id: 2, role: "ORGANIZER" });

    const res = await request(app).get("/events/api/venues/geocode?q=bangna&q=campus");

    expect(res.status).toBe(400);
  });
});

describe("fields a client isn't allowed to set", () => {
  test("organizerId in the body is ignored — the event belongs to whoever is signed in", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.create.mockImplementation(async ({ data }) => ({ id: 5, ...data }));

    await request(app).post("/events/api/events").send({ ...validEvent, organizerId: 999, isLargeConference: true });

    const { data } = prisma.event.create.mock.calls[0][0];
    expect(data.organizerId).toBe(2);
    expect(data.isLargeConference).toBe(false);
  });

  test("a PATCH can't move an event to another organizer or venue", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue({ id: 1, organizerId: 2, status: "PUBLISHED", capacity: 10 });
    prisma.event.update.mockImplementation(async ({ data }) => ({ id: 1, organizerId: 2, status: "PUBLISHED", capacity: 10, ...data }));

    const res = await request(app).patch("/events/api/events/1").send({ title: "Renamed", organizerId: 999, venueId: 42 });

    expect(res.status).toBe(200);
    expect(prisma.event.update.mock.calls[0][0].data).toEqual({ title: "Renamed" });
  });
});

describe("ids", () => {
  test.each([["abc"], ["0"], ["-1"], ["1.5"], ["99999999999"]])("/events/%s is a 404 and never reaches the database", async (id) => {
    setUser({ id: 3, role: "STUDENT" });

    const res = await request(app).get(`/events/api/events/${id}`);

    expect(res.status).toBe(404);
    expect(prisma.event.findUnique).not.toHaveBeenCalled();
  });
});

describe("limits that match the database", () => {
  test("a title longer than the 191-character column is a clear 400, not a database error", async () => {
    setUser({ id: 2, role: "ORGANIZER" });

    const res = await request(app).post("/events/api/events").send({ ...validEvent, title: "x".repeat(192) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/191 characters/);
  });

  test("the audit log limit is checked", async () => {
    setUser({ id: 1, role: "ADMIN" });

    expect((await request(app).get("/events/api/admin/audit?limit=abc")).status).toBe(400);
    expect((await request(app).get("/events/api/admin/audit?limit=5000")).status).toBe(400);

    prisma.auditLog.findMany.mockResolvedValue([]);
    await request(app).get("/events/api/admin/audit");
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });
});
