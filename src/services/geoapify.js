const axios = require("axios");

// docs/proposal.md: reject the event if the address doesn't resolve to a real place;
// otherwise save coordinates and a generated static map URL.
async function geocodeAddress(addressRaw) {
  const { data } = await axios.get("https://api.geoapify.com/v1/geocode/search", {
    params: { text: addressRaw, apiKey: process.env.GEOAPIFY_API_KEY, format: "json" },
  });

  // Geoapify's `confidence` score is not a reliable "does this exist" signal — verified
  // empirically: a correctly full_match'd real place scored confidence 0, while a
  // genuinely bogus address scored an empty `results` array. Emptiness is the real
  // "doesn't resolve" signal; confidence reflects match precision, not existence.
  const best = data.results?.[0];
  if (!best) {
    return null;
  }

  const staticMapUrl =
    "https://maps.geoapify.com/v1/staticmap?style=osm-carto&width=600&height=400" +
    `&center=lonlat:${best.lon},${best.lat}&zoom=15` +
    `&marker=lonlat:${best.lon},${best.lat};color:%23ff0000;size:large` +
    `&apiKey=${process.env.GEOAPIFY_API_KEY}`;

  return { latitude: best.lat, longitude: best.lon, staticMapUrl };
}

module.exports = { geocodeAddress };
