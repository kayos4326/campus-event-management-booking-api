const axios = require("axios");

// docs/proposal.md: reject the event if the address doesn't resolve to a real place;
// otherwise save coordinates and a generated static map URL.
async function geocodeAddress(addressRaw) {
  const { data } = await axios.get("https://api.geoapify.com/v1/geocode/search", {
    params: { text: addressRaw, apiKey: process.env.GEOAPIFY_API_KEY, format: "json" },
  });

  const best = data.results?.[0];
  if (!best || (best.rank?.confidence ?? 0) < 0.5) {
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
