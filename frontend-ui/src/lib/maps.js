// Open a venue pin in Google Maps without using a Google API key.
export const directionsUrl = (venue) =>
  venue?.latitude != null && venue?.longitude != null
    ? `https://www.google.com/maps/search/?api=1&query=${venue.latitude},${venue.longitude}`
    : null
