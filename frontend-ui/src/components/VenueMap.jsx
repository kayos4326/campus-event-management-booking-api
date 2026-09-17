import { useCallback, useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapPin, Search } from 'lucide-react'
import { errorMessage } from '../lib/format'

// AU Suvarnabhumi campus — where the picker opens before a pin is dropped.
const CAMPUS = [13.6117, 100.8377]
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'

// Leaflet's default marker is a PNG that bundlers can't resolve — this is our own pin,
// drawn inline so it matches the app's accent colour and needs no image files.
const pinIcon = L.divIcon({
  className: 'map-pin',
  html: '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M12 22s7-6.4 7-12A7 7 0 0 0 5 10c0 5.6 7 12 7 12Z" fill="currentColor" stroke="white" stroke-width="1.6"/><circle cx="12" cy="10" r="2.6" fill="white"/></svg>',
  iconSize: [30, 30],
  iconAnchor: [15, 28],
})

/**
 * `readOnly` renders a small, non-interactive map of a saved venue.
 * Otherwise it's the picker: click or drag to place the pin, or search for a place.
 */
export default function VenueMap({ value, onChange, api, readOnly, height = 280, label }) {
  const container = useRef(null)
  const map = useRef(null)
  const marker = useRef(null)
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange })
  // The map is created once; re-creating it on every pin drop would reset the view.
  const initial = useRef(value)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')

  const place = useCallback((latlng, { fly } = {}) => {
    if (!map.current) return
    if (marker.current) marker.current.setLatLng(latlng)
    else {
      marker.current = L.marker(latlng, { icon: pinIcon, draggable: !readOnly, keyboard: !readOnly })
        .addTo(map.current)
      if (!readOnly) {
        marker.current.on('dragend', () => {
          const p = marker.current.getLatLng()
          onChangeRef.current?.({ latitude: p.lat, longitude: p.lng })
        })
      }
    }
    if (fly) map.current.setView(latlng, Math.max(map.current.getZoom(), 17))
  }, [readOnly])

  useEffect(() => {
    if (!container.current || map.current) return
    const pinned = initial.current
    map.current = L.map(container.current, {
      center: pinned?.latitude != null ? [pinned.latitude, pinned.longitude] : CAMPUS,
      zoom: pinned?.latitude != null ? 17 : 15,
      zoomControl: !readOnly,
      dragging: !readOnly,
      scrollWheelZoom: false, // page scrolling shouldn't get hijacked by the map
      doubleClickZoom: !readOnly,
      touchZoom: !readOnly,
      keyboard: !readOnly,
      attributionControl: true,
    })
    // OpenStreetMap refuses tile requests with no Referer. Set on the tiles themselves too, so
    // the map still works wherever the page's own header says otherwise (see security.js).
    L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(map.current)
    if (pinned?.latitude != null) place([pinned.latitude, pinned.longitude])
    if (!readOnly) {
      map.current.on('click', (e) => {
        place(e.latlng)
        onChangeRef.current?.({ latitude: e.latlng.lat, longitude: e.latlng.lng })
      })
    }
    // Leaflet measures the container on creation; inside a dialog that's mid-animation.
    const t = setTimeout(() => map.current?.invalidateSize(), 60)
    return () => { clearTimeout(t); map.current?.remove(); map.current = null; marker.current = null }
  }, [place, readOnly])

  const search = async (e) => {
    e.preventDefault()
    if (query.trim().length < 3) return
    setSearching(true)
    setError('')
    try {
      const res = await api.get(`/venues/geocode?q=${encodeURIComponent(query.trim())}`)
      setResults(res.data)
      if (res.data.length === 0) setError('No places found — try a different name, or just click the map.')
    } catch (err) {
      setError(errorMessage(err, 'Search failed — you can still click the map.'))
    } finally {
      setSearching(false)
    }
  }

  const choose = (r) => {
    place([r.latitude, r.longitude], { fly: true })
    onChangeRef.current?.({ latitude: r.latitude, longitude: r.longitude, formatted: r.formatted })
    setResults([])
    setQuery(r.formatted)
  }

  if (readOnly) {
    return <div className="venue-map is-static" style={{ height }} ref={container} aria-label={label || 'Venue location'} />
  }

  return (
    <div className="map-picker">
      <div className="map-search">
        <label className="search">
          <Search />
          <span className="visually-hidden">Search for a place</span>
          <input
            className="input"
            placeholder="Search a place, e.g. Assumption University Suvarnabhumi"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') search(e) }}
          />
        </label>
        <button type="button" className="btn" onClick={search} disabled={searching || query.trim().length < 3}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>

      {results.length > 0 && (
        <ul className="map-results">
          {results.map((r) => (
            <li key={`${r.latitude},${r.longitude}`}>
              <button type="button" onClick={() => choose(r)}><MapPin /> {r.formatted}</button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="field-hint" style={{ color: 'var(--danger)' }}>{error}</p>}

      <div className="venue-map" style={{ height }} ref={container} />

      <p className="field-hint">
        {value?.latitude != null
          ? `📍 Pinned at ${value.latitude.toFixed(5)}, ${value.longitude.toFixed(5)} — drag the pin or click again to adjust.`
          : 'Click the map to drop a pin on the building. Search above to jump there first.'}
      </p>
    </div>
  )
}
