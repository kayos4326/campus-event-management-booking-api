import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarX2, Clock, MapPin, Search } from 'lucide-react'
import { Alert, CapacityBar, DateBadge, EmptyState, Segmented, Spinner, StatusPill, useToast } from './ui'
import { directionsUrl } from './VenueMap'
import { errorMessage, formatTimeRange, isPast, seatInfo } from '../lib/format'

function EventCard({ event, booking, role, busy, onBook }) {
  const { full } = seatInfo(event)
  const ended = isPast(event)
  const venue = event.venue

  let action = null
  if (role === 'STUDENT') {
    if (booking?.status === 'CONFIRMED') action = <StatusPill status="CONFIRMED" label="You're going" />
    else if (booking?.status === 'WAITLISTED') action = <StatusPill status="WAITLISTED" label="You're on the waitlist" />
    else if (ended) action = <button className="btn" disabled>Event ended</button>
    else {
      action = (
        <button className={`btn ${full ? '' : 'btn-primary'}`} disabled={busy} onClick={() => onBook(event)}>
          {busy && <Spinner />}
          {booking?.status === 'CANCELLED' ? (full ? 'Rejoin waitlist' : 'Book again') : full ? 'Join waitlist' : 'Reserve a seat'}
        </button>
      )
    }
  }

  return (
    <article className="event-card">
      <div className="event-media">
        <div className="media-fallback" />
        <DateBadge date={event.startsAt} />
        <div className="media-chips">
          {ended && <span className="pill no-dot">Ended</span>}
        </div>
      </div>
      <div className="event-body">
        <h3 className="event-title">{event.title}</h3>
        {event.description && <p className="event-desc">{event.description}</p>}
        <ul className="meta-list">
          <li><Clock /><span>{formatTimeRange(event.startsAt, event.endsAt)}</span></li>
          {venue && (
            <li>
              <MapPin />
              <span>{venue.name}{venue.roomNumber ? ` · Room ${venue.roomNumber}` : ''}</span>
              {directionsUrl(venue) && (
                <a className="map-link" href={directionsUrl(venue)} target="_blank" rel="noreferrer noopener"
                  onClick={(e) => e.stopPropagation()}>Directions</a>
              )}
            </li>
          )}
        </ul>
        <CapacityBar event={event} />
      </div>
      {action ? <footer className="event-footer">{action}</footer> : <div style={{ height: 18 }} />}
    </article>
  )
}

export default function EventsBrowse({ api, role, onGoToBookings }) {
  const toast = useToast()
  const [events, setEvents] = useState(null)
  const [bookings, setBookings] = useState([])
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [query, setQuery] = useState('')
  const [when, setWhen] = useState('upcoming')

  const load = useCallback(() => {
    api.get('/events')
      .then((res) => { setEvents(res.data); setError('') })
      .catch((err) => { setEvents([]); setError(errorMessage(err, 'Failed to load events')) })
    if (role === 'STUDENT') {
      api.get('/bookings/mine').then((res) => setBookings(res.data)).catch(() => {})
    }
  }, [api, role])

  useEffect(() => { load() }, [load])

  const bookingByEvent = useMemo(
    () => Object.fromEntries(bookings.map((b) => [b.eventId, b])),
    [bookings],
  )

  const upcomingCount = (events || []).filter((e) => !isPast(e)).length

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (events || [])
      .filter((e) => when === 'all' || !isPast(e))
      .filter((e) => !q || [e.title, e.description, e.venue?.name, e.venue?.roomNumber]
        .some((field) => field?.toLowerCase().includes(q)))
  }, [events, query, when])

  const book = async (event) => {
    setBusyId(event.id)
    try {
      const res = await api.post('/bookings', { eventId: event.id })
      if (res.data.status === 'WAITLISTED') {
        toast({
          tone: 'warning',
          title: "You're on the waitlist",
          body: `${event.title} is full. You'll get a seat automatically if someone cancels.`,
        })
      } else {
        toast({ title: 'Seat reserved', body: `You're going to ${event.title}.` })
      }
      load()
    } catch (err) {
      toast({ tone: 'danger', title: "Couldn't book that event", body: errorMessage(err, 'Please try again.') })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Discover events</h1>
          <p>
            {events === null
              ? 'Finding what’s on…'
              : `${upcomingCount} upcoming ${upcomingCount === 1 ? 'event' : 'events'} on campus`}
          </p>
        </div>
        {role === 'STUDENT' && bookings.some((b) => b.status !== 'CANCELLED') && (
          <button className="btn" onClick={onGoToBookings}>View my bookings</button>
        )}
      </div>

      <div className="toolbar">
        <label className="search">
          <Search />
          <span className="visually-hidden">Search events</span>
          <input
            className="input"
            type="search"
            placeholder="Search by title, venue or room"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <Segmented
          label="Filter by date"
          value={when}
          onChange={setWhen}
          options={[
            { value: 'upcoming', label: 'Upcoming' },
            { value: 'all', label: 'All events' },
          ]}
        />
      </div>

      {error && <Alert>{error}</Alert>}

      {events === null ? (
        <div className="event-grid">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton skeleton-card" />)}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState icon={CalendarX2} title={query ? 'No events match your search' : 'Nothing on the calendar yet'}>
          {query
            ? 'Try a different title, venue or room number.'
            : 'Published events will show up here as soon as organizers create them.'}
        </EmptyState>
      ) : (
        <div className="event-grid">
          {visible.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              booking={bookingByEvent[event.id]}
              role={role}
              busy={busyId === event.id}
              onBook={book}
            />
          ))}
        </div>
      )}
    </>
  )
}
