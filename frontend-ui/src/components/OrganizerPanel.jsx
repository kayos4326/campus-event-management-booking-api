import { useEffect, useState } from 'react'

export default function OrganizerPanel({ api }) {
  const [venues, setVenues] = useState([])
  const [events, setEvents] = useState([])
  const [error, setError] = useState('')
  const [attendeesFor, setAttendeesFor] = useState(null)
  const [attendees, setAttendees] = useState([])

  const [venueForm, setVenueForm] = useState({ name: '', roomNumber: '', addressRaw: '' })
  const [venueBusy, setVenueBusy] = useState(false)

  const [eventForm, setEventForm] = useState({
    title: '', description: '', capacity: 10, startsAt: '', endsAt: '',
    venueId: '', isLargeConference: false, status: 'PUBLISHED',
  })
  const [eventBusy, setEventBusy] = useState(false)

  const loadVenues = () => api.get('/venues').then((res) => setVenues(res.data)).catch(() => setError('Failed to load venues'))
  const loadEvents = () => api.get('/events?mine=true').then((res) => setEvents(res.data)).catch(() => setError('Failed to load events'))

  useEffect(() => { loadVenues(); loadEvents() }, [api])

  const createVenue = async (e) => {
    e.preventDefault()
    setVenueBusy(true)
    setError('')
    try {
      await api.post('/venues', venueForm)
      setVenueForm({ name: '', roomNumber: '', addressRaw: '' })
      loadVenues()
    } catch (err) {
      setError(err.response?.data?.error || 'Venue creation failed')
    } finally {
      setVenueBusy(false)
    }
  }

  const createEvent = async (e) => {
    e.preventDefault()
    setEventBusy(true)
    setError('')
    try {
      await api.post('/events', {
        ...eventForm,
        capacity: Number(eventForm.capacity),
        venueId: Number(eventForm.venueId),
        startsAt: new Date(eventForm.startsAt).toISOString(),
        endsAt: new Date(eventForm.endsAt).toISOString(),
      })
      setEventForm({ title: '', description: '', capacity: 10, startsAt: '', endsAt: '', venueId: '', isLargeConference: false, status: 'PUBLISHED' })
      loadEvents()
    } catch (err) {
      setError(err.response?.data?.error || 'Event creation failed')
    } finally {
      setEventBusy(false)
    }
  }

  const cancelEvent = async (id) => {
    if (!window.confirm('Cancel this event? Every confirmed and waitlisted booking for it will be cancelled too.')) return
    setError('')
    try {
      await api.delete(`/events/${id}`)
      loadEvents()
      if (attendeesFor === id) viewAttendees(id)
    } catch (err) {
      setError(err.response?.data?.error || 'Cancelling the event failed')
    }
  }

  const viewAttendees = async (id) => {
    setAttendeesFor(id)
    setAttendees([])
    try {
      const res = await api.get(`/events/${id}/bookings`)
      setAttendees(res.data)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load attendees')
    }
  }

  return (
    <div>
      {error && <p className="error">{error}</p>}

      <section>
        <h2>Create a Venue</h2>
        <form onSubmit={createVenue} className="form">
          <input placeholder="Venue name" required value={venueForm.name}
            onChange={(e) => setVenueForm({ ...venueForm, name: e.target.value })} />
          <input placeholder="Room number (optional)" value={venueForm.roomNumber}
            onChange={(e) => setVenueForm({ ...venueForm, roomNumber: e.target.value })} />
          <input placeholder="Address" required value={venueForm.addressRaw}
            onChange={(e) => setVenueForm({ ...venueForm, addressRaw: e.target.value })} />
          <button disabled={venueBusy}>{venueBusy ? 'Validating address…' : 'Create Venue'}</button>
        </form>
      </section>

      <section>
        <h2>Create an Event</h2>
        <form onSubmit={createEvent} className="form">
          <input placeholder="Title" required value={eventForm.title}
            onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })} />
          <input placeholder="Description" value={eventForm.description}
            onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })} />
          <label>Capacity
            <input type="number" min="1" required value={eventForm.capacity}
              onChange={(e) => setEventForm({ ...eventForm, capacity: e.target.value })} />
          </label>
          <label>Starts
            <input type="datetime-local" required value={eventForm.startsAt}
              onChange={(e) => setEventForm({ ...eventForm, startsAt: e.target.value })} />
          </label>
          <label>Ends
            <input type="datetime-local" required value={eventForm.endsAt}
              onChange={(e) => setEventForm({ ...eventForm, endsAt: e.target.value })} />
          </label>
          <select required value={eventForm.venueId}
            onChange={(e) => setEventForm({ ...eventForm, venueId: e.target.value })}>
            <option value="">Select a venue…</option>
            {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <label>
            <input type="checkbox" checked={eventForm.isLargeConference}
              onChange={(e) => setEventForm({ ...eventForm, isLargeConference: e.target.checked })} />
            Large conference (auto-requests 50 lanyards)
          </label>
          <select value={eventForm.status}
            onChange={(e) => setEventForm({ ...eventForm, status: e.target.value })}>
            <option value="PUBLISHED">Published (visible to students)</option>
            <option value="DRAFT">Draft (hidden)</option>
          </select>
          <button disabled={eventBusy}>{eventBusy ? 'Creating…' : 'Create Event'}</button>
        </form>
      </section>

      <section>
        <h2>My Events</h2>
        <div className="card-grid">
          {events.map((e) => (
            <div className="card" key={e.id}>
              <h3>{e.title} <span className="status">{e.status}</span></h3>
              <p className="meta">📍 {e.venue?.name}</p>
              <p className="meta">🗓 {new Date(e.startsAt).toLocaleString()}</p>
              <div className="row">
                <button onClick={() => viewAttendees(e.id)}>Attendees</button>
                {e.status !== 'CANCELLED' && <button onClick={() => cancelEvent(e.id)}>Cancel Event</button>}
              </div>
              {attendeesFor === e.id && (
                <ul className="attendee-list">
                  {attendees.length === 0 && <li>No bookings yet.</li>}
                  {attendees.map((b) => (
                    <li key={b.id}>{b.student.displayName} — {b.status}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
