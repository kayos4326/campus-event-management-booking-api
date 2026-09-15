import { useEffect, useState } from 'react'

export default function MyBookings({ api }) {
  const [bookings, setBookings] = useState([])
  const [error, setError] = useState('')

  const load = () => {
    api.get('/bookings/mine').then((res) => setBookings(res.data)).catch(() => setError('Failed to load bookings'))
  }

  useEffect(() => { load() }, [api])

  const cancel = async (id) => {
    setError('')
    try {
      await api.patch(`/bookings/${id}/cancel`)
      load()
    } catch (err) {
      setError(err.response?.data?.error || 'Cancel failed')
    }
  }

  return (
    <div>
      <h2>My Bookings</h2>
      {error && <p className="error">{error}</p>}
      {bookings.length === 0 && <p>No bookings yet — RSVP to an event first.</p>}
      <div className="card-grid">
        {bookings.map((b) => (
          <div className="card" key={b.id}>
            <h3>{b.event.title}</h3>
            <p className="meta">🗓 {new Date(b.event.startsAt).toLocaleString()}</p>
            <p>
              Status: <span className={`status status-${b.status.toLowerCase()}`}>{b.status}</span>
            </p>
            {b.status !== 'CANCELLED' && (
              <button onClick={() => cancel(b.id)}>Cancel</button>
            )}
            {b.status === 'CANCELLED' && b.event.status === 'PUBLISHED' && (
              <p className="meta">Changed your mind? RSVP again from the Events tab.</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
