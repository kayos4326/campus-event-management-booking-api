-- Venue locations are now set by dropping a pin on a map, and the map itself is rendered
-- client-side from lat/long (Leaflet + OpenStreetMap). The generated Geoapify static map
-- URL is no longer used — and it embedded the Geoapify API key in every API response.
ALTER TABLE `venues` DROP COLUMN `static_map_url`;
