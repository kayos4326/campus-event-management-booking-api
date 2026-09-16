const request = require("supertest");
const { createApp, prisma, describeLocation, searchPlaces, setUser, resetMocks } = require("./testApp");

const app = createApp();

beforeEach(() => resetMocks());

const CAMPUS = { latitude: 13.6138, longitude: 100.8338 };

describe("POST /events/api/venues", () => {
  test("creates a venue from a dropped pin, with the address filled in from it", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    describeLocation.mockResolvedValue("Assumption University Suvarnabhumi Campus, Thailand");
    prisma.venue.create.mockResolvedValue({ id: 1, name: "AU Auditorium", isVerified: true });

    const res = await request(app)
      .post("/events/api/venues")
      .send({ name: "AU Auditorium", roomNumber: "301", ...CAMPUS });

    expect(res.status).toBe(201);
    expect(describeLocation).toHaveBeenCalledWith(CAMPUS.latitude, CAMPUS.longitude);
    expect(prisma.venue.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "AU Auditorium",
        roomNumber: "301",
        addressRaw: "Assumption University Suvarnabhumi Campus, Thailand",
        latitude: CAMPUS.latitude,
        longitude: CAMPUS.longitude,
        isVerified: true,
      }),
    });
  });

  test("keeps the organizer's own address label when they typed one", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    describeLocation.mockResolvedValue("Boulevard Des Nations, Bang Sao Thong");
    prisma.venue.create.mockResolvedValue({ id: 1 });

    await request(app)
      .post("/events/api/venues")
      .send({ name: "Grand Hall", addressRaw: "AU Grand Hall, Building D", ...CAMPUS });

    expect(prisma.venue.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ addressRaw: "AU Grand Hall, Building D" }) })
    );
  });

  // The pin is what makes a venue correct, so it can't be skipped.
  test.each([
    ["no pin at all", {}],
    ["only a latitude", { latitude: 13.6 }],
    ["a non-numeric pin", { latitude: "here", longitude: "there" }],
    ["an impossible latitude", { latitude: 120, longitude: 100 }],
  ])("400 for %s", async (_name, pin) => {
    setUser({ id: 2, role: "ORGANIZER" });

    const res = await request(app).post("/events/api/venues").send({ name: "Somewhere", ...pin });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pin/i);
    expect(describeLocation).not.toHaveBeenCalled();
    expect(prisma.venue.create).not.toHaveBeenCalled();
  });

  test("422 when the pin isn't on a recognisable place (e.g. the middle of the sea)", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    describeLocation.mockResolvedValue(null);

    const res = await request(app)
      .post("/events/api/venues")
      .send({ name: "Nowhere", latitude: 0, longitude: 0 });

    expect(res.status).toBe(422);
    expect(prisma.venue.create).not.toHaveBeenCalled();
  });

  test("400 when the name is missing", async () => {
    setUser({ id: 2, role: "ORGANIZER" });

    const res = await request(app).post("/events/api/venues").send({ ...CAMPUS });

    expect(res.status).toBe(400);
    expect(describeLocation).not.toHaveBeenCalled();
  });

  test("403 when a Student tries to create a venue", async () => {
    setUser({ id: 5, role: "STUDENT" });

    const res = await request(app).post("/events/api/venues").send({ name: "AU Auditorium", ...CAMPUS });

    expect(res.status).toBe(403);
  });
});

describe("GET /events/api/venues/geocode", () => {
  test("returns places for the map picker to jump to", async () => {
    setUser({ id: 2, role: "ORGANIZER" });
    searchPlaces.mockResolvedValue([{ formatted: "AU Suvarnabhumi", ...CAMPUS }]);

    const res = await request(app).get("/events/api/venues/geocode?q=assumption");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ formatted: "AU Suvarnabhumi", ...CAMPUS }]);
    expect(searchPlaces).toHaveBeenCalledWith("assumption");
  });

  test("400 for a too-short query, without calling Geoapify", async () => {
    setUser({ id: 2, role: "ORGANIZER" });

    const res = await request(app).get("/events/api/venues/geocode?q=au");

    expect(res.status).toBe(400);
    expect(searchPlaces).not.toHaveBeenCalled();
  });

  test("403 for a Student", async () => {
    setUser({ id: 5, role: "STUDENT" });

    const res = await request(app).get("/events/api/venues/geocode?q=assumption");

    expect(res.status).toBe(403);
  });
});
