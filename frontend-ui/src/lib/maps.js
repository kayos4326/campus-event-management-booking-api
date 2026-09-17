// A plain Google Maps link for a venue's pin — no API key needed.
// Kept out of components/VenueMap.jsx so the pages that only need this link (Discover,
// My bookings) don't pull Leaflet into the main bundle.
export const directionsUrl = (venue) =>
  venue?.latitude != null && venue?.longitude != null
    ? `https://www.google.com/maps/search/?api=1&query=${venue.latitude},${venue.longitude}`
    : null
