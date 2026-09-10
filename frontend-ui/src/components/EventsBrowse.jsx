import { useEffect, useState } from 'react'

export default function EventsBrowse({ api, role }) {
  const [events, setEvents] = useState([])
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)

  const load = () => {
    api.get('/events').then((res) => setEvents(res.data)).catch(() => setError('Failed to load events'))
  }

  useEffect(() => { load() }, [api])

  const book = async (eventId) => {
    setBusyId(eventId)
    setError('')
    try {
      await api.post('/bookings', { eventId })
      load()
    } catch (err) {
      setError(err.response?.data?.error || 'Booking failed')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <h2>Published Events</h2>
      {error && <p className="error">{error}</p>}
      {events.length === 0 && <p>No published events yet.</p>}
      <div className="card-grid">
        {events.map((e) => (
          <div className="card" key={e.id}>
            <h3>{e.title}{e.isLargeConference && ' 🎪'}</h3>
            <p>{e.description}</p>
            <p className="meta">📍 {e.venue?.name} {e.venue?.roomNumber && `(Room ${e.venue.roomNumber})`}</p>
            <p className="meta">🗓 {new Date(e.startsAt).toLocaleString()} – {new Date(e.endsAt).toLocaleString()}</p>
            <p className="meta">Capacity: {e.capacity}</p>
            {role === 'STUDENT' && (
              <button disabled={busyId === e.id} onClick={() => book(e.id)}>
                {busyId === e.id ? 'Booking…' : 'RSVP'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
