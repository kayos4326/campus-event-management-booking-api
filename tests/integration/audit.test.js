const request = require("supertest");
const { createApp, prisma, describeLocation, setUser, resetMocks } = require("./testApp");

const app = createApp();

beforeEach(() => resetMocks());

const loggedSummary = () => prisma.auditLog.create.mock.calls.map((c) => c[0].data);

describe("audit trail", () => {
  test("cancelling an event records who did it and how many bookings it released", async () => {
    setUser({ id: 2, role: "ORGANIZER", displayName: "THAR LIN HTET -" });
    prisma.event.findUnique.mockResolvedValue({ id: 7, organizerId: 2, title: "Tech Talk", status: "PUBLISHED" });
    prisma.event.update.mockResolvedValue({ id: 7, organizerId: 2, title: "Tech Talk", status: "CANCELLED" });
    prisma.booking.count.mockResolvedValue(3);

    await request(app).delete("/events/api/events/7");

    const entry = loggedSummary()[0];
    expect(entry).toMatchObject({ action: "event.cancelled", entityType: "event", entityId: 7, actorId: 2 });
    expect(entry.actorLabel).toBe("Thar Lin Htet"); // tidied from the AU directory name
    expect(entry.summary).toContain("Cancelled \"Tech Talk\"");
    expect(entry.summary).toContain("3 booking(s)");
  });

  test("an edit records what actually changed", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue({ id: 7, organizerId: 2, title: "Old", capacity: 10, status: "PUBLISHED" });
    prisma.event.update.mockResolvedValue({ id: 7, organizerId: 2, title: "New", capacity: 25, status: "PUBLISHED" });

    await request(app).patch("/events/api/events/7").send({ title: "New", capacity: 25 });

    expect(loggedSummary()[0].summary).toContain('title "Old" → "New"');
    expect(loggedSummary()[0].summary).toContain("capacity 10 → 25");
  });

  test("an edit that changes nothing isn't logged", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue({ id: 7, organizerId: 2, title: "Same", capacity: 10, status: "PUBLISHED" });
    prisma.event.update.mockResolvedValue({ id: 7, organizerId: 2, title: "Same", capacity: 10, status: "PUBLISHED" });

    await request(app).patch("/events/api/events/7").send({ title: "Same" });

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test("a role change records the before and after", async () => {
    setUser({ id: 1, role: "ADMIN" });
    prisma.user.findUnique.mockResolvedValue({ id: 5, role: "STUDENT" });
    prisma.user.update.mockResolvedValue({ id: 5, role: "ORGANIZER", email: "s@au.edu" });

    await request(app).patch("/events/api/admin/users/5/role").send({ role: "ORGANIZER" });

    expect(loggedSummary()[0]).toMatchObject({ action: "user.role_changed", entityId: 5 });
    expect(loggedSummary()[0].summary).toContain("student → organizer");
  });

  // A lost log line must never break the action it describes.
  test("a failing audit write doesn't fail the request", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.auditLog.create.mockRejectedValue(new Error("db down"));
    prisma.event.findUnique.mockResolvedValue({ id: 7, organizerId: 2, title: "T", status: "PUBLISHED" });
    prisma.event.update.mockResolvedValue({ id: 7, organizerId: 2, title: "T", status: "CANCELLED" });

    const res = await request(app).delete("/events/api/events/7");

    expect(res.status).toBe(200);
  });
});

describe("GET /events/api/events/:id/history", () => {
  test("the owner sees the event's history, newest first", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue({ id: 7, organizerId: 2 });
    prisma.auditLog.findMany.mockResolvedValue([{ id: 1, summary: "Created" }]);

    const res = await request(app).get("/events/api/events/7/history");

    expect(res.status).toBe(200);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entityType: "event", entityId: 7 }, orderBy: { createdAt: "desc" } })
    );
  });

  test("another organizer can't read it (403)", async () => {
    setUser({ id: 3, role: "ORGANIZER" });
    prisma.event.findUnique.mockResolvedValue({ id: 7, organizerId: 2 });

    expect((await request(app).get("/events/api/events/7/history")).status).toBe(403);
  });

  test("a student can't read it (403)", async () => {
    setUser({ id: 9, role: "STUDENT" });

    expect((await request(app).get("/events/api/events/7/history")).status).toBe(403);
  });
});

describe("GET /events/api/admin/audit", () => {
  test("admins see recent activity", async () => {
    setUser({ id: 1, role: "ADMIN" });
    prisma.auditLog.findMany.mockResolvedValue([]);

    const res = await request(app).get("/events/api/admin/audit");

    expect(res.status).toBe(200);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: "desc" }, take: 100 });
  });

  test("organizers can't (403)", async () => {
    setUser({ id: 2, role: "ORGANIZER" });

    expect((await request(app).get("/events/api/admin/audit")).status).toBe(403);
  });
});

describe("DELETE /events/api/venues/:id", () => {
  test("an unused venue is deleted for real", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.venue.findUnique.mockResolvedValue({ id: 3, name: "Old Hall", _count: { events: 0 } });
    prisma.venue.delete.mockResolvedValue({ id: 3 });

    const res = await request(app).delete("/events/api/venues/3");

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("deleted");
    expect(prisma.venue.delete).toHaveBeenCalledWith({ where: { id: 3 } });
  });

  // Deleting it would destroy the history of events that used it.
  test("a venue still used by events is archived instead", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.venue.findUnique.mockResolvedValue({ id: 3, name: "Grand Hall", isArchived: false, _count: { events: 4 } });
    prisma.venue.update.mockResolvedValue({ id: 3, isArchived: true });

    const res = await request(app).delete("/events/api/venues/3");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "archived", eventCount: 4 });
    expect(prisma.venue.delete).not.toHaveBeenCalled();
    expect(loggedSummary()[0].action).toBe("venue.archived");
  });

  test("409 when it's already archived and still in use", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.venue.findUnique.mockResolvedValue({ id: 3, name: "Grand Hall", isArchived: true, _count: { events: 4 } });

    expect((await request(app).delete("/events/api/venues/3")).status).toBe(409);
  });

  test("students can't delete venues (403)", async () => {
    setUser({ id: 9, role: "STUDENT" });

    expect((await request(app).delete("/events/api/venues/3")).status).toBe(403);
    expect(prisma.venue.delete).not.toHaveBeenCalled();
  });

  test("404 for a venue that doesn't exist", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.venue.findUnique.mockResolvedValue(null);

    expect((await request(app).delete("/events/api/venues/999")).status).toBe(404);
  });

  test("archived venues are hidden from the venue list by default", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    prisma.venue.findMany.mockResolvedValue([]);

    await request(app).get("/events/api/venues");
    expect(prisma.venue.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { isArchived: false } }));

    await request(app).get("/events/api/venues?includeArchived=true");
    expect(prisma.venue.findMany.mock.calls[1][0].where).toEqual({});
  });
});
