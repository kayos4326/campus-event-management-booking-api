import { useCallback, useEffect, useMemo, useState } from 'react'
import { Ban, Clock, Hourglass, MapPin, Ticket } from 'lucide-react'
import { Alert, ConfirmDialog, EmptyState, Segmented, Spinner, StatusPill, useToast } from './ui'
import { directionsUrl } from './VenueMap'
import { mediaUrl } from '../api'
import { dayOfMonth, errorMessage, formatTimeRange, isPast, monthShort, weekdayShort } from '../lib/format'

function TicketCard({ booking, busy, onCancel, onRebook }) {
  const { event } = booking
  const cancelled = booking.status === 'CANCELLED'
  const eventCancelled = event.status === 'CANCELLED'
  const ended = isPast(event)
  const canRebook = cancelled && !eventCancelled && event.status === 'PUBLISHED' && !ended

  return (
    <article className={`ticket ${cancelled ? 'is-cancelled' : ''}`}>
      <div className="ticket-stub">
        <span>{monthShort(event.startsAt)}</span>
        <strong>{dayOfMonth(event.startsAt)}</strong>
        <small>{weekdayShort(event.startsAt)}</small>
      </div>
      {event.imageUrl && <img className="ticket-photo" src={mediaUrl(event.imageUrl)} alt="" loading="lazy" />}
      <div className="ticket-main">
        <div className="ticket-top">
          <h3>{event.title}</h3>
          {ended && !cancelled ? <StatusPill status="ENDED" /> : <StatusPill status={booking.status} />}
        </div>
        <ul className="meta-list meta-inline">
          <li><Clock /><span>{formatTimeRange(event.startsAt, event.endsAt)}</span></li>
          {event.venue && (
            <li>
              <MapPin />
              <span>{event.venue.name}{event.venue.roomNumber ? ` · Room ${event.venue.roomNumber}` : ''}</span>
              {directionsUrl(event.venue) && (
                <a className="map-link" href={directionsUrl(event.venue)} target="_blank" rel="noreferrer noopener">Directions</a>
              )}
            </li>
          )}
        </ul>
        {booking.status === 'WAITLISTED' && !ended && (
          <p className="hint warning"><Hourglass /> You'll be moved up automatically if a seat opens.</p>
        )}
        {eventCancelled && <p className="hint danger"><Ban /> The organizer cancelled this event.</p>}
      </div>
      {(!cancelled && !ended) || canRebook ? (
        <div className="ticket-actions">
          {!cancelled && !ended && (
            <button className="btn btn-sm btn-danger" onClick={() => onCancel(booking)} disabled={busy}>
              Cancel booking
            </button>
          )}
          {canRebook && (
            <button className="btn btn-sm btn-primary" onClick={() => onRebook(booking)} disabled={busy}>
              {busy && <Spinner />} Book again
            </button>
          )}
        </div>
      ) : null}
    </article>
  )
}

export default function MyBookings({ api, onBrowse }) {
  const toast = useToast()
  const [bookings, setBookings] = useState(null)
  const [error, setError] = useState('')
  const [view, setView] = useState('upcoming')
  const [busyId, setBusyId] = useState(null)
  const [toCancel, setToCancel] = useState(null)

  const load = useCallback(() => {
    api.get('/bookings/mine')
      .then((res) => { setBookings(res.data); setError('') })
      .catch((err) => { setBookings([]); setError(errorMessage(err, 'Failed to load bookings')) })
  }, [api])

  useEffect(() => { load() }, [load])

  const groups = useMemo(() => {
    const all = bookings || []
    const byStart = (a, b) => new Date(a.event.startsAt) - new Date(b.event.startsAt)
    return {
      upcoming: all.filter((b) => b.status !== 'CANCELLED' && !isPast(b.event)).sort(byStart),
      past: all.filter((b) => b.status !== 'CANCELLED' && isPast(b.event)).sort((a, b) => byStart(b, a)),
      cancelled: all.filter((b) => b.status === 'CANCELLED'),
    }
  }, [bookings])

  const confirmCancel = async () => {
    const booking = toCancel
    setBusyId(booking.id)
    try {
      await api.patch(`/bookings/${booking.id}/cancel`)
      toast({ title: 'Booking cancelled', body: `Your seat for ${booking.event.title} was released.` })
      setToCancel(null)
      load()
    } catch (err) {
      toast({ tone: 'danger', title: "Couldn't cancel", body: errorMessage(err, 'Please try again.') })
    } finally {
      setBusyId(null)
    }
  }

  const rebook = async (booking) => {
    setBusyId(booking.id)
    try {
      const res = await api.post('/bookings', { eventId: booking.eventId })
      toast(res.data.status === 'WAITLISTED'
        ? { tone: 'warning', title: "You're on the waitlist", body: `${booking.event.title} is full right now.` }
        : { title: 'Seat reserved', body: `You're going to ${booking.event.title}.` })
      setView('upcoming')
      load()
    } catch (err) {
      toast({ tone: 'danger', title: "Couldn't book that event", body: errorMessage(err, 'Please try again.') })
    } finally {
      setBusyId(null)
    }
  }

  const list = groups[view]
  const emptyCopy = {
    upcoming: ['No upcoming bookings', 'Find something on the Discover tab and reserve a seat.'],
    past: ['No past events yet', 'Events you attended will show up here.'],
    cancelled: ['No cancelled bookings', 'Bookings you cancel show up here, so you can book again.'],
  }[view]

  return (
    <>
      <div className="page-header">
        <div>
          <h1>My bookings</h1>
          <p>Your seats, waitlist spots and past events.</p>
        </div>
      </div>

      <div className="toolbar">
        <Segmented
          label="Booking status"
          value={view}
          onChange={setView}
          options={[
            { value: 'upcoming', label: 'Upcoming', count: groups.upcoming.length },
            { value: 'past', label: 'Past', count: groups.past.length },
            { value: 'cancelled', label: 'Cancelled', count: groups.cancelled.length },
          ]}
        />
      </div>

      {error && <Alert>{error}</Alert>}

      {bookings === null ? (
        <div className="ticket-list">
          {[0, 1].map((i) => <div key={i} className="skeleton skeleton-row" />)}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={Ticket}
          title={emptyCopy[0]}
          action={view === 'upcoming' && <button className="btn btn-primary" onClick={onBrowse}>Discover events</button>}
        >
          {emptyCopy[1]}
        </EmptyState>
      ) : (
        <div className="ticket-list">
          {list.map((b) => (
            <TicketCard key={b.id} booking={b} busy={busyId === b.id} onCancel={setToCancel} onRebook={rebook} />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!toCancel}
        title="Cancel this booking?"
        confirmLabel="Cancel booking"
        danger
        busy={!!toCancel && busyId === toCancel.id}
        onConfirm={confirmCancel}
        onClose={() => setToCancel(null)}
      >
        {toCancel?.status === 'CONFIRMED'
          ? `Your seat for ${toCancel.event.title} will go to the next person on the waitlist. You can book again later if seats are still available.`
          : `You'll leave the waitlist for ${toCancel?.event.title}.`}
      </ConfirmDialog>
    </>
  )
}
