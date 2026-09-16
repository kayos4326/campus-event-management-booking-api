jest.mock("axios");
const axios = require("axios");
const { searchPlaces, describeLocation } = require("../../src/services/geoapify");

beforeEach(() => {
  process.env.GEOAPIFY_API_KEY = "test-key";
  axios.get.mockReset();
});

// Regression test for a real bug (CLAUDE.md §9): an unbiased search for "assumption
// university" returned Assumption University in Worcester, Massachusetts, so two saved
// venues pointed at the wrong place. Searches are now filtered to Thailand and biased
// toward the AU campus.
describe("searchPlaces", () => {
  test("filters to Thailand and biases toward the campus", async () => {
    axios.get.mockResolvedValue({ data: { results: [] } });

    await searchPlaces("assumption university");

    const { params } = axios.get.mock.calls[0][1];
    expect(params.filter).toBe("countrycode:th");
    expect(params.bias).toBe("proximity:100.8377,13.6117");
    expect(params.text).toBe("assumption university");
  });

  test("returns the places the pin can jump to", async () => {
    axios.get.mockResolvedValue({
      data: {
        results: [
          { formatted: "Assumption University Suvarnabhumi Campus, Thailand", lat: 13.6138, lon: 100.8338 },
        ],
      },
    });

    await expect(searchPlaces("assumption university")).resolves.toEqual([
      { formatted: "Assumption University Suvarnabhumi Campus, Thailand", latitude: 13.6138, longitude: 100.8338 },
    ]);
  });

  test("returns an empty list when nothing matches", async () => {
    axios.get.mockResolvedValue({ data: {} });

    await expect(searchPlaces("asdkjaslkdj zzxxccvv")).resolves.toEqual([]);
  });
});

describe("describeLocation", () => {
  test("turns a pin into an address", async () => {
    axios.get.mockResolvedValue({
      data: { results: [{ formatted: "Boulevard Des Nations, Bang Sao Thong, Thailand", country: "Thailand", distance: 5 }] },
    });

    await expect(describeLocation(13.6138, 100.8338)).resolves.toBe("Boulevard Des Nations, Bang Sao Thong, Thailand");
    expect(axios.get.mock.calls[0][1].params).toMatchObject({ lat: 13.6138, lon: 100.8338 });
  });

  // Found on the live API: reverse geocoding labels the pin with the nearest landmark,
  // even when that landmark is a different building ~95m away.
  test("drops the nearest-landmark prefix when it's not the pinned spot", async () => {
    axios.get.mockResolvedValue({
      data: {
        results: [{
          name: "Museum",
          formatted: "Museum, Boulevard Des Nations, Bang Sao Thong, Thailand",
          country: "Thailand",
          distance: 95,
        }],
      },
    });

    await expect(describeLocation(13.6138, 100.8338)).resolves.toBe("Boulevard Des Nations, Bang Sao Thong, Thailand");
  });

  test("keeps the landmark name when the pin is right on it", async () => {
    axios.get.mockResolvedValue({
      data: { results: [{ name: "Grand Hall", formatted: "Grand Hall, Bang Sao Thong, Thailand", country: "Thailand", distance: 8 }] },
    });

    await expect(describeLocation(13.6138, 100.8338)).resolves.toBe("Grand Hall, Bang Sao Thong, Thailand");
  });

  // A pin in the open sea still returns a result — `{ formatted: "Earth" }` for 0,0 —
  // but with no country. Found by the live API test, which expected a 422 and got a 201.
  test("returns null for a pin with no country (the middle of the sea)", async () => {
    axios.get.mockResolvedValue({ data: { results: [{ formatted: "Earth", name: "Earth" }] } });

    await expect(describeLocation(0, 0)).resolves.toBeNull();
  });

  test("returns null when there are no results at all", async () => {
    axios.get.mockResolvedValue({ data: { results: [] } });

    await expect(describeLocation(0, 0)).resolves.toBeNull();
  });
});
