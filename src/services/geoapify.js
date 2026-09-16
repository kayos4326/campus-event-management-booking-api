const axios = require("axios");

// Venue locations are set by dropping a pin on a map (see frontend-ui MapPicker), so
// Geoapify's job is now:
//   1. `searchPlaces` — type-ahead that moves the pin to a place the organizer names
//   2. `describeLocation` — turn the dropped pin into a real address, which also proves
//      the pin is on a recognisable place rather than in the middle of the sea
//
// Both are biased to Thailand near the AU campus. Without that bias, Geoapify resolved
// "assumption university" to Assumption University in Worcester, Massachusetts (found
// 2026-09-16 — two saved venues were pointing at the wrong continent/province).
const COUNTRY = process.env.GEOAPIFY_COUNTRY || "th";
const BIAS_LAT = Number(process.env.GEOAPIFY_BIAS_LAT || 13.6117); // AU Suvarnabhumi campus
const BIAS_LON = Number(process.env.GEOAPIFY_BIAS_LON || 100.8377);

async function searchPlaces(text, limit = 5) {
  const { data } = await axios.get("https://api.geoapify.com/v1/geocode/search", {
    params: {
      text,
      limit,
      filter: `countrycode:${COUNTRY}`,
      bias: `proximity:${BIAS_LON},${BIAS_LAT}`,
      apiKey: process.env.GEOAPIFY_API_KEY,
      format: "json",
    },
  });

  return (data.results || []).map((r) => ({
    formatted: r.formatted,
    latitude: r.lat,
    longitude: r.lon,
  }));
}

// Returns the address of a pinned point, or null if it isn't a recognisable place.
async function describeLocation(latitude, longitude) {
  const { data } = await axios.get("https://api.geoapify.com/v1/geocode/reverse", {
    params: { lat: latitude, lon: longitude, apiKey: process.env.GEOAPIFY_API_KEY, format: "json" },
  });

  const best = data.results?.[0];
  // A pin in the open sea still returns a result — literally `{ formatted: "Earth" }` for
  // 0,0 — but with no country. A real place always has one.
  if (!best || !best.country) return null;

  // Reverse geocoding names the nearest landmark, which can be a different building
  // ("Museum, Boulevard Des Nations, …" for a pin 95m from a museum). Drop that prefix.
  const FAR_ENOUGH_TO_BE_A_DIFFERENT_PLACE = 50; // metres
  if (best.name && best.distance > FAR_ENOUGH_TO_BE_A_DIFFERENT_PLACE && best.formatted.startsWith(`${best.name}, `)) {
    return best.formatted.slice(best.name.length + 2);
  }
  return best.formatted;
}

module.exports = { searchPlaces, describeLocation };
