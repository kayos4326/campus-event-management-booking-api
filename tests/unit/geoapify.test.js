jest.mock("axios");
const axios = require("axios");
const { geocodeAddress } = require("../../src/services/geoapify");

// Regression test for a real bug (CLAUDE.md §8): confidence is NOT a reliable "does
// this exist" signal — a correctly full_match'd real place scored confidence: 0, while
// genuinely bogus input correctly returned an empty results array. The fix checks for
// the presence of any result at all, not a confidence threshold.
describe("geocodeAddress", () => {
  beforeEach(() => {
    process.env.GEOAPIFY_API_KEY = "test-key";
  });

  test("returns coordinates + a static map URL when a result exists, even with low/zero confidence", async () => {
    axios.get.mockResolvedValue({
      data: {
        results: [
          { lat: 13.5976, lon: 100.5972, rank: { confidence: 0 } }, // the exact case that broke the old threshold check
        ],
      },
    });

    const result = await geocodeAddress("Assumption University, Bang Na");

    expect(result).toEqual({
      latitude: 13.5976,
      longitude: 100.5972,
      staticMapUrl: expect.stringContaining("https://maps.geoapify.com/v1/staticmap"),
    });
  });

  test("returns null when results is empty (genuinely bogus address)", async () => {
    axios.get.mockResolvedValue({ data: { results: [] } });

    const result = await geocodeAddress("asdkjaslkdj zzxxccvv nonexistent place qqq");

    expect(result).toBeNull();
  });

  test("returns null when results is missing entirely", async () => {
    axios.get.mockResolvedValue({ data: {} });

    const result = await geocodeAddress("whatever");

    expect(result).toBeNull();
  });
});
