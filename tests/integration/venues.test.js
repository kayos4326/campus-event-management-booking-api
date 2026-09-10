const request = require("supertest");
const { createApp, prisma, geocodeAddress, setUser, resetMocks } = require("./testApp");

const app = createApp();

beforeEach(() => resetMocks());

describe("POST /events/api/venues", () => {
  test("creates a venue when the address resolves", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    geocodeAddress.mockResolvedValue({
      latitude: 13.5976,
      longitude: 100.5972,
      staticMapUrl: "https://maps.geoapify.com/v1/staticmap?...",
    });
    prisma.venue.create.mockResolvedValue({ id: 1, name: "AU Auditorium", isVerified: true });

    const res = await request(app)
      .post("/events/api/venues")
      .send({ name: "AU Auditorium", addressRaw: "Assumption University, Bang Na" });

    expect(res.status).toBe(201);
    expect(prisma.venue.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isVerified: true }) })
    );
  });

  test("422 when the address doesn't resolve to a real place", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    geocodeAddress.mockResolvedValue(null);

    const res = await request(app)
      .post("/events/api/venues")
      .send({ name: "Nowhere", addressRaw: "asdkjaslkdj zzxxccvv nonexistent" });

    expect(res.status).toBe(422);
    expect(prisma.venue.create).not.toHaveBeenCalled();
  });

  test("400 when required fields are missing", async () => {
    setUser({ id: 2, role: "ORGANIZER" });

    const res = await request(app).post("/events/api/venues").send({ name: "No address" });

    expect(res.status).toBe(400);
    expect(geocodeAddress).not.toHaveBeenCalled();
  });

  test("403 when a Student tries to create a venue", async () => {
    setUser({ id: 5, role: "STUDENT" });

    const res = await request(app)
      .post("/events/api/venues")
      .send({ name: "AU Auditorium", addressRaw: "Assumption University" });

    expect(res.status).toBe(403);
  });
});
