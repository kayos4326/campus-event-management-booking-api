import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Ban, BadgeCheck, Building2, CalendarCheck, CalendarPlus, Clock, FilePen, Hourglass,
  MapPin, Megaphone, Pencil, Plus, Send, Users,
} from 'lucide-react'
import {
  Alert, CapacityBar, ConfirmDialog, DateBadge, EmptyState, Modal, Person, Segmented,
  Spinner, StatCard, StatusPill, useToast,
} from './ui'
import { errorMessage, formatDate, formatTimeRange, isPast, toLocalInput } from '../lib/format'

const emptyEvent = {
  title: '', description: '', capacity: 50, startsAt: '', endsAt: '',
  venueId: '', isLargeConference: false, status: 'PUBLISHED',
}

function EventFormModal({ open, mode, initial, venues, onClose, onSubmit, onAddVenue }) {
  // Remounted (via `key`) each time it opens, so the form starts from `initial`.
  const [form, setForm] = useState(() => (initial
    ? { ...emptyEvent, ...initial, startsAt: toLocalInput(initial.startsAt), endsAt: toLocalInput(initial.endsAt) }
    : emptyEvent))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = (key) => (e) =>
    setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  const submit = async (e) => {
    e.preventDefault()
    if (new Date(form.endsAt) <= new Date(form.startsAt)) {
      setError('The event has to end after it starts.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await onSubmit(form)
    } catch (err) {
      setError(errorMessage(err, 'Saving the event failed'))
    } finally {
      setBusy(false)
    }
  }

  const editing = mode === 'edit'

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="wide"
      title={editing ? 'Edit event' : 'Create an event'}
      description={editing ? 'Changes are visible to students right away.' : 'Students can reserve seats as soon as it’s published.'}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="event-form" className="btn btn-primary" disabled={busy}>
            {busy && <Spinner />}
            {editing ? 'Save changes' : form.status === 'PUBLISHED' ? 'Publish event' : 'Save draft'}
          </button>
        </>
      }
    >
      {error && <Alert>{error}</Alert>}
      <form id="event-form" className="form-grid" onSubmit={submit}>
        <label className="field span-2">
          <span className="field-label">Title</span>
          <input className="input" required value={form.title} onChange={set('title')} placeholder="e.g. Career Fair 2026" autoFocus />
        </label>
        <label className="field span-2">
          <span className="field-label">Description</span>
          <textarea className="textarea" value={form.description || ''} onChange={set('description')} placeholder="What should students know before they book?" />
        </label>
        <label className="field">
          <span className="field-label">Starts</span>
          <input className="input" type="datetime-local" required value={form.startsAt} onChange={set('startsAt')} />
        </label>
        <label className="field">
          <span className="field-label">Ends</span>
          <input className="input" type="datetime-local" required value={form.endsAt} onChange={set('endsAt')} />
        </label>
        <div className="field">
          <label className="field-label" htmlFor="event-venue">Venue</label>
          {editing ? (
            <input id="event-venue" className="input" disabled value={initial?.venue?.name || ''} />
          ) : (
            <select id="event-venue" className="select" required value={form.venueId} onChange={set('venueId')}>
              <option value="">Choose a venue…</option>
              {venues.map((v) => (
                <option key={v.id} value={v.id}>{v.name}{v.roomNumber ? ` (Room ${v.roomNumber})` : ''}</option>
              ))}
            </select>
          )}
          {!editing && (
            <span className="field-hint">
              Not listed? <button type="button" className="btn btn-ghost btn-sm" style={{ height: 'auto', padding: 0, color: 'var(--accent-text)' }} onClick={() => onAddVenue((venue) => setForm((f) => ({ ...f, venueId: String(venue.id) })))}>Add a venue</button>
            </span>
          )}
        </div>
        <label className="field">
          <span className="field-label">Capacity</span>
          <input className="input" type="number" min="1" step="1" required value={form.capacity} onChange={set('capacity')} />
          <span className="field-hint">Seats that can be confirmed. Anyone after that joins the waitlist.</span>
        </label>
        {!editing && (
          <>
            <label className="switch span-2">
              <input type="checkbox" checked={form.isLargeConference} onChange={set('isLargeConference')} />
              <span className="switch-track" />
              <span className="switch-text">
                <strong>Large conference</strong>
                <span>Automatically posts a request for 50 lanyards to the team's Discord channel.</span>
              </span>
            </label>
            <div className="field span-2">
              <span className="field-label">Visibility</span>
              <div>
                <Segmented
                  label="Visibility"
                  value={form.status}
                  onChange={(status) => setForm({ ...form, status })}
                  options={[
                    { value: 'PUBLISHED', label: 'Publish now' },
                    { value: 'DRAFT', label: 'Save as draft' },
                  ]}
                />
              </div>
            </div>
          </>
        )}
      </form>
    </Modal>
  )
}

function VenueModal({ open, onClose, onCreated, api }) {
  const [form, setForm] = useState({ name: '', roomNumber: '', addressRaw: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = await api.post('/venues', form)
      onCreated(res.data)
    } catch (err) {
      setError(errorMessage(err, 'Creating the venue failed'))
    } finally {
      setBusy(false)
    }
  }

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a venue"
      description="We check the address is a real place and generate a map for it."
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="venue-form" className="btn btn-primary" disabled={busy}>
            {busy && <Spinner />} {busy ? 'Verifying address…' : 'Add venue'}
          </button>
        </>
      }
    >
      {error && <Alert>{error}</Alert>}
      <form id="venue-form" className="form-grid" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Venue name</span>
          <input className="input" required value={form.name} onChange={set('name')} placeholder="e.g. Grand Hall" autoFocus />
        </label>
        <label className="field">
          <span className="field-label">Room number <span className="field-hint">(optional)</span></span>
          <input className="input" value={form.roomNumber} onChange={set('roomNumber')} placeholder="e.g. 301" />
        </label>
        <label className="field span-2">
          <span className="field-label">Address</span>
          <input className="input" required value={form.addressRaw} onChange={set('addressRaw')} placeholder="Street, district, province" />
          <span className="field-hint">The room number is what the public room-status API looks up.</span>
        </label>
      </form>
    </Modal>
  )
}

function AttendeesModal({ event, api, onClose }) {
  const [bookings, setBookings] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!event) return
    api.get(`/events/${event.id}/bookings`)
      .then((res) => setBookings(res.data))
      .catch((err) => { setBookings([]); setError(errorMessage(err, 'Failed to load attendees')) })
  }, [event, api])

  const order = { CONFIRMED: 0, WAITLISTED: 1, CANCELLED: 2 }
  const sorted = [...(bookings || [])].sort(
    (a, b) => order[a.status] - order[b.status] || new Date(a.createdAt) - new Date(b.createdAt),
  )
  const count = (status) => (bookings || []).filter((b) => b.status === status).length

  return (
    <Modal
      open={!!event}
      onClose={onClose}
      size="wide"
      title="Attendees"
      description={event && `${event.title} · ${count('CONFIRMED')} confirmed · ${count('WAITLISTED')} waitlisted`}
    >
      {error && <Alert>{error}</Alert>}
      {bookings === null ? (
        <div style={{ display: 'grid', placeItems: 'center', padding: 40 }}><Spinner className="loader" /></div>
      ) : sorted.length === 0 ? (
        <EmptyState icon={Users} title="No bookings yet">Students who reserve a seat will appear here.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Student</th><th>Status</th><th>Booked</th></tr></thead>
            <tbody>
              {sorted.map((b) => (
                <tr key={b.id}>
                  <td><Person name={b.student.displayName} email={b.student.email} /></td>
                  <td><StatusPill status={b.status} /></td>
                  <td className="muted nowrap">{formatDate(b.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

export default function OrganizerPanel({ api }) {
  const toast = useToast()
  const [venues, setVenues] = useState([])
  const [events, setEvents] = useState(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')

  const [formMode, setFormMode] = useState(null) // 'create' | 'edit' | null
  const [editing, setEditing] = useState(null)
  const [venueOpen, setVenueOpen] = useState(false)
  const [attendeesFor, setAttendeesFor] = useState(null)
  const [toCancel, setToCancel] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const selectNewVenue = useRef(null)

  const loadVenues = useCallback(
    () => api.get('/venues').then((res) => setVenues(res.data)).catch(() => setError('Failed to load venues')),
    [api],
  )
  const loadEvents = useCallback(
    () => api.get('/events?mine=true')
      .then((res) => setEvents(res.data))
      .catch((err) => { setEvents([]); setError(errorMessage(err, 'Failed to load your events')) }),
    [api],
  )

  useEffect(() => { loadVenues(); loadEvents() }, [loadVenues, loadEvents])

  const stats = useMemo(() => {
    const list = events || []
    const live = list.filter((e) => e.status === 'PUBLISHED')
    return {
      upcoming: live.filter((e) => !isPast(e)).length,
      drafts: list.filter((e) => e.status === 'DRAFT').length,
      booked: live.reduce((sum, e) => sum + (e.seats?.confirmed || 0), 0),
      waiting: live.reduce((sum, e) => sum + (e.seats?.waitlisted || 0), 0),
    }
  }, [events])

  const counts = useMemo(() => {
    const list = events || []
    return {
      all: list.length,
      PUBLISHED: list.filter((e) => e.status === 'PUBLISHED').length,
      DRAFT: list.filter((e) => e.status === 'DRAFT').length,
      CANCELLED: list.filter((e) => e.status === 'CANCELLED').length,
    }
  }, [events])

  const visible = (events || []).filter((e) => filter === 'all' || e.status === filter)

  const submitEvent = async (form) => {
    if (formMode === 'edit') {
      await api.patch(`/events/${editing.id}`, {
        title: form.title,
        description: form.description,
        capacity: Number(form.capacity),
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
      })
      toast({ title: 'Event updated', body: form.title })
    } else {
      await api.post('/events', {
        ...form,
        capacity: Number(form.capacity),
        venueId: Number(form.venueId),
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
      })
      toast({
        title: form.status === 'PUBLISHED' ? 'Event published' : 'Draft saved',
        body: form.isLargeConference ? 'Lanyard request sent to Discord.' : form.title,
      })
    }
    setFormMode(null)
    setEditing(null)
    loadEvents()
  }

  const publish = async (event) => {
    setBusyId(event.id)
    try {
      await api.patch(`/events/${event.id}`, { status: 'PUBLISHED' })
      toast({ title: 'Event published', body: `${event.title} is now visible to students.` })
      loadEvents()
    } catch (err) {
      toast({ tone: 'danger', title: "Couldn't publish", body: errorMessage(err, 'Please try again.') })
    } finally {
      setBusyId(null)
    }
  }

  const confirmCancel = async () => {
    const event = toCancel
    setBusyId(event.id)
    try {
      await api.delete(`/events/${event.id}`)
      toast({ title: 'Event cancelled', body: 'All bookings for it were cancelled too.' })
      setToCancel(null)
      loadEvents()
    } catch (err) {
      toast({ tone: 'danger', title: "Couldn't cancel the event", body: errorMessage(err, 'Please try again.') })
    } finally {
      setBusyId(null)
    }
  }

  const openCreate = () => { setEditing(null); setFormMode('create') }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>My events</h1>
          <p>Create events, keep an eye on bookings, and manage your venues.</p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => { selectNewVenue.current = null; setVenueOpen(true) }}><Building2 /> Add venue</button>
          <button className="btn btn-primary" onClick={openCreate}><Plus /> New event</button>
        </div>
      </div>

      {error && <Alert>{error}</Alert>}

      <div className="stats">
        <StatCard icon={CalendarCheck} tone="accent" value={stats.upcoming} label="Upcoming events" />
        <StatCard icon={FilePen} value={stats.drafts} label="Drafts" />
        <StatCard icon={Users} tone="success" value={stats.booked} label="Seats booked" />
        <StatCard icon={Hourglass} tone="warning" value={stats.waiting} label="On waitlists" />
      </div>

      <div className="toolbar">
        <Segmented
          label="Filter events"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'PUBLISHED', label: 'Published', count: counts.PUBLISHED },
            { value: 'DRAFT', label: 'Drafts', count: counts.DRAFT },
            { value: 'CANCELLED', label: 'Cancelled', count: counts.CANCELLED },
          ]}
        />
      </div>

      {events === null ? (
        <div className="manage-list">
          {[0, 1].map((i) => <div key={i} className="skeleton skeleton-row" />)}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={CalendarPlus}
          title={filter === 'all' ? 'You haven’t created any events yet' : 'Nothing here'}
          action={filter === 'all' && <button className="btn btn-primary" onClick={openCreate}><Plus /> Create your first event</button>}
        >
          {filter === 'all' ? 'Pick a venue, set a capacity, and publish it for students to book.' : 'No events with this status.'}
        </EmptyState>
      ) : (
        <div className="manage-list">
          {visible.map((event) => {
            const cancelled = event.status === 'CANCELLED'
            const ended = isPast(event)
            return (
              <article key={event.id} className="card manage-card">
                <DateBadge date={event.startsAt} muted={cancelled || ended} />
                <div className="manage-main">
                  <div className="manage-title">
                    <h3>{event.title}</h3>
                    {ended && !cancelled ? <StatusPill status="ENDED" /> : <StatusPill status={event.status} />}
                    {event.isLargeConference && <span className="pill no-dot pill-accent"><Megaphone /> Large conference</span>}
                  </div>
                  <ul className="meta-list meta-inline">
                    <li><Clock /><span>{formatTimeRange(event.startsAt, event.endsAt)}</span></li>
                    {event.venue && <li><MapPin /><span>{event.venue.name}{event.venue.roomNumber ? ` · Room ${event.venue.roomNumber}` : ''}</span></li>}
                  </ul>
                  {!cancelled && <CapacityBar event={event} />}
                </div>
                <div className="manage-actions">
                  <button className="btn btn-sm" onClick={() => setAttendeesFor(event)}><Users /> Attendees</button>
                  {!cancelled && !ended && (
                    <button className="btn btn-sm" onClick={() => { setEditing(event); setFormMode('edit') }}><Pencil /> Edit</button>
                  )}
                  {event.status === 'DRAFT' && (
                    <button className="btn btn-sm btn-primary" onClick={() => publish(event)} disabled={busyId === event.id}>
                      {busyId === event.id ? <Spinner /> : <Send />} Publish
                    </button>
                  )}
                  {!cancelled && !ended && (
                    <button className="btn btn-sm btn-danger" onClick={() => setToCancel(event)}><Ban /> Cancel</button>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}

      <section className="section">
        <div className="section-head">
          <h2>Venues</h2>
          <p>{venues.length} verified {venues.length === 1 ? 'venue' : 'venues'}, shared by all organizers</p>
        </div>
        {venues.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No venues yet"
            action={<button className="btn" onClick={() => { selectNewVenue.current = null; setVenueOpen(true) }}><Plus /> Add a venue</button>}
          >
            Every event needs a venue. Add one with a real address.
          </EmptyState>
        ) : (
          <div className="venue-grid">
            {venues.map((v) => (
              <div key={v.id} className="card venue-card">
                <div className="event-media">
                  {v.staticMapUrl ? <img src={v.staticMapUrl} alt={`Map of ${v.name}`} loading="lazy" /> : <div className="media-fallback" />}
                </div>
                <div className="venue-card-body">
                  <strong>{v.name}{v.isVerified && <BadgeCheck aria-label="Verified address" />}</strong>
                  <span>{v.roomNumber ? `Room ${v.roomNumber} · ` : ''}{v.addressRaw}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <EventFormModal
        key={formMode ? `${formMode}-${editing?.id ?? 'new'}` : 'closed'}
        open={!!formMode}
        mode={formMode}
        initial={editing}
        venues={venues}
        onClose={() => { setFormMode(null); setEditing(null) }}
        onSubmit={submitEvent}
        onAddVenue={(selectVenue) => { selectNewVenue.current = selectVenue; setVenueOpen(true) }}
      />

      <VenueModal
        key={venueOpen ? 'venue-open' : 'venue-closed'}
        open={venueOpen}
        api={api}
        onClose={() => { selectNewVenue.current = null; setVenueOpen(false) }}
        onCreated={(venue) => {
          setVenueOpen(false)
          // Opened from inside "Create an event"? Pick the new venue there too.
          selectNewVenue.current?.(venue)
          selectNewVenue.current = null
          toast({ title: 'Venue added', body: `${venue.name} — address verified.` })
          loadVenues()
        }}
      />

      <AttendeesModal key={attendeesFor?.id ?? 'none'} event={attendeesFor} api={api} onClose={() => setAttendeesFor(null)} />

      <ConfirmDialog
        open={!!toCancel}
        title="Cancel this event?"
        confirmLabel="Cancel event"
        danger
        busy={!!toCancel && busyId === toCancel.id}
        onConfirm={confirmCancel}
        onClose={() => setToCancel(null)}
      >
        {toCancel && `${toCancel.title} will be marked as cancelled, and all ${toCancel.seats?.confirmed || 0} confirmed and ${toCancel.seats?.waitlisted || 0} waitlisted bookings will be cancelled with it. This can't be undone from the app.`}
      </ConfirmDialog>
    </>
  )
}
