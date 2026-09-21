import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Ban, BadgeCheck, Building2, CalendarCheck, CalendarPlus, Clock, FilePen, History, Hourglass,
  MapPin, Megaphone, Pencil, Plus, Send, Trash2, Users,
} from 'lucide-react'
import {
  Alert, CapacityBar, ConfirmDialog, DateBadge, EmptyState, Modal, Person, Segmented,
  Spinner, StatCard, StatusPill, useToast,
} from './ui'
import VenueMap from './VenueMap'
import { directionsUrl } from '../lib/maps'
import ImagePicker from './ImagePicker'
import { mediaUrl } from '../api'
import { errorMessage, formatDate, formatTimeRange, isPast, timeAgo, toLocalInput } from '../lib/format'

const emptyEvent = {
  title: '', description: '', capacity: 50, startsAt: '', endsAt: '',
  venueId: '', supplyItem: '', supplyQuantity: '', status: 'PUBLISHED',
  // The event must exist before its image can be uploaded.
  imageUrl: null, imageBlob: null, imagePreview: null, imageCleared: false,
}

function EventFormModal({ open, mode, initial, venues, onClose, onSubmit, onAddVenue }) {
  // This form is remounted each time it opens.
  const [form, setForm] = useState(() => (initial
    ? { ...emptyEvent, ...initial, startsAt: toLocalInput(initial.startsAt), endsAt: toLocalInput(initial.endsAt) }
    : emptyEvent))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = (key) => (e) =>
    setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  // Show the selected image or the image already saved.
  const preview = form.imagePreview || (form.imageCleared ? null : mediaUrl(form.imageUrl))

  const pickImage = (blob, url) => {
    if (form.imagePreview) URL.revokeObjectURL(form.imagePreview)
    setForm({ ...form, imageBlob: blob, imagePreview: url, imageCleared: !blob })
  }

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
        <div className="field span-2">
          <span className="field-label">Cover image <span className="field-hint">(optional)</span></span>
          <ImagePicker preview={preview} onChange={pickImage} />
        </div>
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
            <div className="field span-2">
              <span className="field-label">Order supplies <span className="field-hint">(optional)</span></span>
              <div className="supply-fields">
                <input className="input" placeholder="What to order, e.g. Blank lanyards"
                  value={form.supplyItem} onChange={set('supplyItem')} maxLength={100} />
                <input className="input" type="number" min="1" step="1"
                  placeholder={form.capacity ? `How many (default ${form.capacity})` : 'How many'}
                  value={form.supplyQuantity} onChange={set('supplyQuantity')} disabled={!form.supplyItem.trim()} />
              </div>
              <span className="field-hint">
                Posted to the team's Discord channel when the event is created. Leave the amount empty to order one per seat.
              </span>
            </div>
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
  const [pin, setPin] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    if (!pin) {
      setError('Drop a pin on the map so students know where the venue is.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await api.post('/venues', { ...form, latitude: pin.latitude, longitude: pin.longitude })
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
      size="wide"
      title="Add a venue"
      description="Drop a pin on the exact building — that's what students see on the map."
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="venue-form" className="btn btn-primary" disabled={busy || !pin}>
            {busy && <Spinner />} {busy ? 'Saving…' : 'Add venue'}
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
        <div className="field span-2">
          <span className="field-label">Location <span className="field-hint">(required — click the map)</span></span>
          <VenueMap
            api={api}
            value={pin}
            onChange={(next) => {
              setPin(next)
              setError('')
              // Search results include an address; plain pins are described by the API.
              if (next.formatted && !form.addressRaw.trim()) setForm((f) => ({ ...f, addressRaw: next.formatted }))
            }}
          />
        </div>
        <label className="field span-2">
          <span className="field-label">Address label <span className="field-hint">(optional)</span></span>
          <input className="input" value={form.addressRaw} onChange={set('addressRaw')} placeholder="Filled in from the pin if you leave it empty" />
          <span className="field-hint">The room number is what the public room-status API looks up.</span>
        </label>
      </form>
    </Modal>
  )
}

// Venue editing changes labels only, not the map pin.
function VenueEditModal({ open, venue, onClose, onSaved, api }) {
  const [form, setForm] = useState({
    name: venue?.name ?? '',
    roomNumber: venue?.roomNumber ?? '',
    addressRaw: venue?.addressRaw ?? '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })

  // Send only fields that changed.
  const changes = {}
  if (venue) {
    if (form.name.trim() !== (venue.name ?? '')) changes.name = form.name.trim()
    if (form.roomNumber.trim() !== (venue.roomNumber ?? '')) changes.roomNumber = form.roomNumber.trim()
    if (form.addressRaw.trim() !== (venue.addressRaw ?? '')) changes.addressRaw = form.addressRaw.trim()
  }
  const dirty = Object.keys(changes).length > 0

  const submit = async (e) => {
    e.preventDefault()
    if (!dirty) return
    setBusy(true)
    setError('')
    try {
      const res = await api.patch(`/venues/${venue.id}`, changes)
      onSaved(res.data)
    } catch (err) {
      setError(errorMessage(err, 'Saving the venue failed'))
    } finally {
      setBusy(false)
    }
  }

  if (!venue) return null

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="wide"
      title="Edit this venue"
      description="Correct the name, room or address label. The location stays where it is."
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="venue-edit-form" className="btn btn-primary" disabled={busy || !dirty}>
            {busy && <Spinner />} {busy ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }
    >
      {error && <Alert>{error}</Alert>}
      <form id="venue-edit-form" className="form-grid" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Venue name</span>
          <input className="input" required value={form.name} onChange={set('name')} autoFocus />
        </label>
        <label className="field">
          <span className="field-label">Room number <span className="field-hint">(optional)</span></span>
          <input className="input" value={form.roomNumber} onChange={set('roomNumber')} placeholder="e.g. 301" />
        </label>
        {venue.latitude != null && (
          <div className="field span-2">
            <span className="field-label">Location <span className="field-hint">(can't be moved)</span></span>
            <VenueMap readOnly value={venue} height={130} label={`Map showing ${venue.name}`} />
          </div>
        )}
        <label className="field span-2">
          <span className="field-label">Address label <span className="field-hint">(optional)</span></span>
          <input className="input" value={form.addressRaw} onChange={set('addressRaw')} placeholder="e.g. AU Grand Hall, Building D" />
          <span className="field-hint">The room number is what the public room-status API looks up.</span>
        </label>
      </form>
    </Modal>
  )
}

function HistoryModal({ event, api, onClose }) {
  const [entries, setEntries] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!event) return
    api.get(`/events/${event.id}/history`)
      .then((res) => setEntries(res.data))
      .catch((err) => { setEntries([]); setError(errorMessage(err, 'Failed to load the history')) })
  }, [event, api])

  return (
    <Modal open={!!event} onClose={onClose} title="Event history" description={event?.title}>
      {error && <Alert>{error}</Alert>}
      {entries === null ? (
        <div style={{ display: 'grid', placeItems: 'center', padding: 40 }}><Spinner className="loader" /></div>
      ) : entries.length === 0 ? (
        <EmptyState icon={History} title="Nothing recorded yet">Changes to this event will be listed here.</EmptyState>
      ) : (
        <ol className="timeline">
          {entries.map((e) => (
            <li key={e.id}>
              <div className="timeline-dot" />
              <div>
                <strong>{e.summary}</strong>
                <span className="meta">{e.actorLabel} · {timeAgo(e.createdAt)} · {formatDate(e.createdAt)}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
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
  const [historyFor, setHistoryFor] = useState(null)
  const [venueToEdit, setVenueToEdit] = useState(null)
  const [venueToRemove, setVenueToRemove] = useState(null)
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

  // Image upload is separate because it needs the new event id.
  const saveImage = async (eventId, form) => {
    try {
      if (form.imageBlob) {
        await api.post(`/events/${eventId}/image`, form.imageBlob, { headers: { 'Content-Type': form.imageBlob.type } })
      } else if (form.imageCleared && form.imageUrl) {
        await api.delete(`/events/${eventId}/image`)
      }
    } catch (err) {
      toast({
        tone: 'warning',
        title: 'The event was saved, but the image wasn’t',
        body: errorMessage(err, 'Open Edit and try adding it again.'),
      })
    }
  }

  const submitEvent = async (form) => {
    if (formMode === 'edit') {
      await api.patch(`/events/${editing.id}`, {
        title: form.title,
        description: form.description,
        capacity: Number(form.capacity),
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
      })
      await saveImage(editing.id, form)
      toast({ title: 'Event updated', body: form.title })
    } else {
      const item = form.supplyItem.trim()
      const quantity = form.supplyQuantity === '' ? undefined : Number(form.supplyQuantity)
      const { data: created } = await api.post('/events', {
        title: form.title,
        description: form.description,
        status: form.status,
        capacity: Number(form.capacity),
        venueId: Number(form.venueId),
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
        ...(item && { supply: { item, ...(quantity !== undefined && { quantity }) } }),
      })
      await saveImage(created.id, form)
      toast({
        title: form.status === 'PUBLISHED' ? 'Event published' : 'Draft saved',
        body: item
          ? form.status === 'PUBLISHED'
            ? `${quantity ?? Number(form.capacity)} × ${item} requested in Discord.`
            : `${quantity ?? Number(form.capacity)} × ${item} will be ordered when you publish.`
          : form.title,
      })
      // Refresh again after the Discord worker has had time to run.
      if (item && form.status === 'PUBLISHED') setTimeout(loadEvents, 3000)
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
      // Refresh again to show the Discord delivery result.
      if (event.preorder && event.preorder.status !== 'CONFIRMED') setTimeout(loadEvents, 3000)
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

  const removeVenue = async () => {
    const venue = venueToRemove
    setBusyId(`venue-${venue.id}`)
    try {
      const { data } = await api.delete(`/venues/${venue.id}`)
      toast(data.outcome === 'deleted'
        ? { title: 'Venue deleted', body: `${venue.name} wasn't used by any event.` }
        : { tone: 'warning', title: 'Venue archived', body: `${venue.name} is used by ${data.eventCount} event(s), so it was hidden instead of deleted.` })
      setVenueToRemove(null)
      loadVenues()
    } catch (err) {
      toast({ tone: 'danger', title: "Couldn't remove the venue", body: errorMessage(err, 'Please try again.') })
    } finally {
      setBusyId(null)
    }
  }

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
                {event.imageUrl && <img className="manage-thumb" src={mediaUrl(event.imageUrl)} alt="" loading="lazy" />}
                <DateBadge date={event.startsAt} muted={cancelled || ended} />
                <div className="manage-main">
                  <div className="manage-title">
                    <h3>{event.title}</h3>
                    {ended && !cancelled ? <StatusPill status="ENDED" /> : <StatusPill status={event.status} />}
                    {event.preorder && (
                      <span
                        className={`pill no-dot ${event.preorder.status === 'FAILED' ? 'pill-danger' : event.preorder.status === 'PENDING' ? 'pill-neutral' : 'pill-accent'}`}
                        title={event.preorder.status === 'FAILED'
                          ? "Discord didn't accept this request"
                          : event.preorder.status === 'PENDING' ? 'Sending to Discord…' : 'Requested in Discord'}
                      >
                        <Megaphone /> {event.preorder.quantity} × {event.preorder.item}
                        {event.preorder.status === 'FAILED' && ' (not sent)'}
                      </span>
                    )}
                  </div>
                  <ul className="meta-list meta-inline">
                    <li><Clock /><span>{formatTimeRange(event.startsAt, event.endsAt)}</span></li>
                    {event.venue && <li><MapPin /><span>{event.venue.name}{event.venue.roomNumber ? ` · Room ${event.venue.roomNumber}` : ''}</span></li>}
                  </ul>
                  {!cancelled && <CapacityBar event={event} />}
                </div>
                <div className="manage-actions">
                  <button className="btn btn-sm" onClick={() => setAttendeesFor(event)}><Users /> Attendees</button>
                  <button className="btn btn-sm" onClick={() => setHistoryFor(event)}><History /> History</button>
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
                {v.latitude != null ? (
                  <VenueMap readOnly value={v} height={130} label={`Map showing ${v.name}`} />
                ) : (
                  <div className="event-media"><div className="media-fallback" /></div>
                )}
                <div className="venue-card-body">
                  <strong>{v.name}{v.isVerified && <BadgeCheck aria-label="Verified address" />}</strong>
                  <span>{v.roomNumber ? `Room ${v.roomNumber} · ` : ''}{v.addressRaw}</span>
                  <div className="venue-card-actions">
                    {directionsUrl(v) && (
                      <a className="map-link" href={directionsUrl(v)} target="_blank" rel="noreferrer noopener">
                        <MapPin /> Open in Google Maps
                      </a>
                    )}
                    <button className="btn btn-sm btn-ghost" onClick={() => setVenueToEdit(v)} aria-label={`Edit ${v.name}`}>
                      <Pencil /> Edit
                    </button>
                    <button className="btn btn-sm btn-ghost btn-danger" onClick={() => setVenueToRemove(v)} aria-label={`Remove ${v.name}`}>
                      <Trash2 /> Remove
                    </button>
                  </div>
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
          // Select the new venue in the open event form.
          selectNewVenue.current?.(venue)
          selectNewVenue.current = null
          toast({ title: 'Venue added', body: `${venue.name} — address verified.` })
          loadVenues()
        }}
      />

      <VenueEditModal
        key={`venue-edit-${venueToEdit?.id ?? 'none'}`}
        open={!!venueToEdit}
        venue={venueToEdit}
        api={api}
        onClose={() => setVenueToEdit(null)}
        onSaved={(venue) => {
          setVenueToEdit(null)
          toast({ title: 'Venue updated', body: `${venue.name} was saved.` })
          loadVenues()
        }}
      />

      <AttendeesModal key={attendeesFor?.id ?? 'none'} event={attendeesFor} api={api} onClose={() => setAttendeesFor(null)} />

      <HistoryModal key={`history-${historyFor?.id ?? 'none'}`} event={historyFor} api={api} onClose={() => setHistoryFor(null)} />

      <ConfirmDialog
        open={!!venueToRemove}
        title="Remove this venue?"
        confirmLabel="Remove venue"
        danger
        busy={busyId === `venue-${venueToRemove?.id}`}
        onConfirm={removeVenue}
        onClose={() => setVenueToRemove(null)}
      >
        {venueToRemove && `If no event has used "${venueToRemove.name}" it's deleted for good. If events do use it, it's archived instead — hidden when creating new events, but still shown on the existing ones, so their history stays intact.`}
      </ConfirmDialog>

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
