const axios = require("axios");

// Geoapify powers venue search and converts a required map pin into a readable address.
// Results are restricted to Thailand and biased toward the AU Suvarnabhumi campus.
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
  // Geoapify may describe invalid coordinates as "Earth"; real places include a country.
  if (!best || !best.country) return null;

  // Remove a distant landmark prefix so the address describes the pin itself.
  const FAR_ENOUGH_TO_BE_A_DIFFERENT_PLACE = 50; // metres
  if (best.name && best.distance > FAR_ENOUGH_TO_BE_A_DIFFERENT_PLACE && best.formatted.startsWith(`${best.name}, `)) {
    return best.formatted.slice(best.name.length + 2);
  }
  return best.formatted;
}

module.exports = { searchPlaces, describeLocation };
