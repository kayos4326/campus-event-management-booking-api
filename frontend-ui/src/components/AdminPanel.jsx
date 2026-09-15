import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarDays, Check, Copy, KeyRound, Ticket, TriangleAlert, UserCog, Users } from 'lucide-react'
import {
  Alert, ConfirmDialog, EmptyState, Person, RolePill, Segmented, Spinner, StatCard, StatusPill, useToast,
} from './ui'
import { cleanName, errorMessage, formatDate, seatInfo } from '../lib/format'

const ROLES = ['STUDENT', 'ORGANIZER', 'ADMIN']
const title = (role) => role[0] + role.slice(1).toLowerCase()

function UsersTable({ users, me, onChangeRole }) {
  if (users.length === 0) return <EmptyState icon={Users} title="No users yet">People appear here after their first sign-in.</EmptyState>
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Person</th><th>Role</th><th>Joined</th><th>Change role</th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td><Person name={u.displayName} email={u.email} /></td>
              <td><RolePill role={u.role} /></td>
              <td className="muted nowrap">{formatDate(u.createdAt)}</td>
              <td>
                {u.id === me?.id ? (
                  <span className="muted" title="Another Admin has to change your role">That's you</span>
                ) : (
                  <select
                    className="select role-select"
                    value=""
                    onChange={(e) => e.target.value && onChangeRole(u, e.target.value)}
                    aria-label={`Change role for ${cleanName(u.displayName)}`}
                  >
                    <option value="">Change to…</option>
                    {ROLES.filter((r) => r !== u.role).map((r) => <option key={r} value={r}>{title(r)}</option>)}
                  </select>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EventsTable({ events }) {
  if (events.length === 0) return <EmptyState icon={CalendarDays} title="No events yet">Events created by organizers appear here.</EmptyState>
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Event</th><th>Organizer</th><th>Date</th><th>Status</th><th>Seats</th></tr></thead>
        <tbody>
          {events.map((e) => {
            const { confirmed, waitlisted } = seatInfo(e)
            return (
              <tr key={e.id}>
                <td>
                  <strong>{e.title}</strong>
                  <div className="muted" style={{ fontSize: 13 }}>{e.venue?.name}{e.venue?.roomNumber ? ` · Room ${e.venue.roomNumber}` : ''}</div>
                </td>
                <td className="nowrap">{cleanName(e.organizer?.displayName)}</td>
                <td className="muted nowrap">{formatDate(e.startsAt)}</td>
                <td><StatusPill status={e.status} /></td>
                <td className="nowrap">
                  {confirmed}/{e.capacity}
                  {waitlisted > 0 && <span className="muted"> · {waitlisted} waiting</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function BookingsTable({ bookings }) {
  if (bookings.length === 0) return <EmptyState icon={Ticket} title="No bookings yet">Student reservations appear here.</EmptyState>
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Student</th><th>Event</th><th>Status</th><th>Booked</th></tr></thead>
        <tbody>
          {bookings.map((b) => (
            <tr key={b.id}>
              <td><Person name={b.student?.displayName} email={b.student?.email} /></td>
              <td>{b.event?.title}</td>
              <td><StatusPill status={b.status} /></td>
              <td className="muted nowrap">{formatDate(b.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ApiKeys({ api }) {
  const toast = useToast()
  const [form, setForm] = useState({ ownerLabel: '', scope: 'room-status:read' })
  const [keys, setKeys] = useState(null)
  const [revealed, setRevealed] = useState(null) // { id, key } — shown once, right after issuing
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [toRevoke, setToRevoke] = useState(null)
  const [revoking, setRevoking] = useState(false)

  useEffect(() => {
    api.get('/admin/api-keys')
      .then((res) => setKeys(res.data))
      .catch((err) => { setKeys([]); setError(errorMessage(err, 'Failed to load API keys')) })
  }, [api])

  const issue = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { data } = await api.post('/admin/api-keys', form)
      const { key, ...stored } = data
      setKeys((list) => [stored, ...(list || [])])
      setRevealed({ id: data.id, key })
      setForm({ ownerLabel: '', scope: 'room-status:read' })
      setCopied(false)
    } catch (err) {
      setError(errorMessage(err, 'Issuing the key failed'))
    } finally {
      setBusy(false)
    }
  }

  const confirmRevoke = async () => {
    const target = toRevoke
    setRevoking(true)
    try {
      await api.delete(`/admin/api-keys/${target.id}`)
      setKeys((list) => list.map((k) => (k.id === target.id ? { ...k, isActive: false } : k)))
      if (revealed?.id === target.id) setRevealed(null)
      setToRevoke(null)
      toast({ title: 'Key revoked', body: `${target.ownerLabel} can no longer call the API.` })
    } catch (err) {
      toast({ tone: 'danger', title: "Couldn't revoke the key", body: errorMessage(err, 'Please try again.') })
    } finally {
      setRevoking(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(revealed.key)
      setCopied(true)
    } catch {
      toast({ tone: 'warning', title: 'Copy failed', body: 'Select the key and copy it manually.' })
    }
  }

  const activeCount = (keys || []).filter((k) => k.isActive).length

  return (
    <>
      <div className="split">
        <div className="card card-pad">
          <h3 className="card-title">Issue an API key</h3>
          <p className="card-sub">Keys let other apps check whether an event is running in a room right now.</p>
          {error && <Alert>{error}</Alert>}
          <form className="stack-sm" onSubmit={issue}>
            <label className="field">
              <span className="field-label">Who is this key for?</span>
              <input className="input" required placeholder="e.g. Library display screen" value={form.ownerLabel}
                onChange={(e) => setForm({ ...form, ownerLabel: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Scope</span>
              <input className="input" required value={form.scope}
                onChange={(e) => setForm({ ...form, scope: e.target.value })} />
              <span className="field-hint">The room-status endpoint only accepts <code>room-status:read</code>.</span>
            </label>
            <div><button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : <KeyRound />} Issue key</button></div>
          </form>

          {revealed && (
            <div className="key-reveal" style={{ marginTop: 20 }}>
              <p><TriangleAlert /> Copy this key now — it won't be shown again.</p>
              <div className="key-row">
                <code>{revealed.key}</code>
                <button type="button" className="btn btn-sm" onClick={copy}>{copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}</button>
              </div>
            </div>
          )}
        </div>

        <div className="card card-pad">
          <h3 className="card-title">How it's called</h3>
          <p className="card-sub">Returns the event running in that room, or <code>{'{"active": false}'}</code>.</p>
          <code className="code-block">
            <span className="k">GET</span> /events/api/peer/events/active?room=301{'\n'}
            <span className="k">x-api-key:</span> {'<your key>'}{'\n\n'}
            <span className="c">{'// → { "active": true, "eventId": 5, "title": "…" }'}</span>
          </code>
        </div>
      </div>

      <section className="section">
        <div className="section-head">
          <h2>All keys</h2>
          <p>{activeCount} active · only a hash of each key is stored</p>
        </div>
        {keys === null ? (
          <div className="skeleton skeleton-row" />
        ) : keys.length === 0 ? (
          <EmptyState icon={KeyRound} title="No keys issued yet">Issue a key above to let another app read room status.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Issued to</th><th>Created</th><th>Status</th><th /></tr></thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td><strong>{k.ownerLabel}</strong><div className="muted" style={{ fontSize: 13 }}>{k.scope}</div></td>
                    <td className="muted nowrap">{formatDate(k.createdAt)}</td>
                    <td>{k.isActive ? <span className="pill pill-success">Active</span> : <span className="pill pill-neutral">Revoked</span>}</td>
                    <td style={{ textAlign: 'right' }}>
                      {k.isActive && <button className="btn btn-sm btn-danger" onClick={() => setToRevoke(k)}>Revoke</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={!!toRevoke}
        title="Revoke this key?"
        confirmLabel="Revoke key"
        danger
        busy={revoking}
        onConfirm={confirmRevoke}
        onClose={() => setToRevoke(null)}
      >
        {toRevoke && `Anything using the key for "${toRevoke.ownerLabel}" will immediately get 401 errors. This can't be undone — you'd have to issue a new key.`}
      </ConfirmDialog>
    </>
  )
}

export default function AdminPanel({ api, me }) {
  const toast = useToast()
  const [users, setUsers] = useState(null)
  const [events, setEvents] = useState([])
  const [bookings, setBookings] = useState([])
  const [error, setError] = useState('')
  const [view, setView] = useState('users')
  const [roleChange, setRoleChange] = useState(null)
  const [busy, setBusy] = useState(false)

  const loadAll = useCallback(() => {
    api.get('/admin/users')
      .then((res) => { setUsers(res.data); setError('') })
      .catch(() => { setUsers([]); setError('Failed to load admin data — if your role just changed, sign out and back in.') })
    api.get('/admin/events').then((res) => setEvents(res.data)).catch(() => {})
    api.get('/admin/bookings').then((res) => setBookings(res.data)).catch(() => {})
  }, [api])

  useEffect(() => { loadAll() }, [loadAll])

  const stats = useMemo(() => ({
    users: users?.length ?? 0,
    organizers: (users || []).filter((u) => u.role !== 'STUDENT').length,
    events: events.filter((e) => e.status === 'PUBLISHED').length,
    bookings: bookings.filter((b) => b.status !== 'CANCELLED').length,
  }), [users, events, bookings])

  const confirmRoleChange = async () => {
    const { user, role } = roleChange
    setBusy(true)
    try {
      await api.patch(`/admin/users/${user.id}/role`, { role })
      toast({ title: 'Role updated', body: `${cleanName(user.displayName)} is now ${role === 'ADMIN' ? 'an' : 'a'} ${title(role)}.` })
      setRoleChange(null)
      loadAll()
    } catch (err) {
      toast({ tone: 'danger', title: "Couldn't change the role", body: errorMessage(err, 'Please try again.') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Admin</h1>
          <p>Manage people and roles, see everything on the platform, and control API access.</p>
        </div>
      </div>

      {error && <Alert>{error}</Alert>}

      <div className="stats">
        <StatCard icon={Users} tone="info" value={stats.users} label="People signed in" />
        <StatCard icon={UserCog} tone="accent" value={stats.organizers} label="Organizers & admins" />
        <StatCard icon={CalendarDays} tone="success" value={stats.events} label="Published events" />
        <StatCard icon={Ticket} tone="warning" value={stats.bookings} label="Active bookings" />
      </div>

      <div className="toolbar">
        <Segmented
          label="Admin section"
          value={view}
          onChange={setView}
          options={[
            { value: 'users', label: 'People', count: users?.length ?? 0 },
            { value: 'events', label: 'Events', count: events.length },
            { value: 'bookings', label: 'Bookings', count: bookings.length },
            { value: 'keys', label: 'API keys' },
          ]}
        />
      </div>

      {users === null ? (
        <div className="skeleton skeleton-row" style={{ height: 240 }} />
      ) : (
        <>
          {view === 'users' && <UsersTable users={users} me={me} onChangeRole={(user, role) => setRoleChange({ user, role })} />}
          {view === 'events' && <EventsTable events={events} />}
          {view === 'bookings' && <BookingsTable bookings={bookings} />}
          {view === 'keys' && <ApiKeys api={api} />}
        </>
      )}

      <ConfirmDialog
        open={!!roleChange}
        title="Change role?"
        confirmLabel="Change role"
        busy={busy}
        onConfirm={confirmRoleChange}
        onClose={() => setRoleChange(null)}
      >
        {roleChange && `${cleanName(roleChange.user.displayName)} will go from ${title(roleChange.user.role)} to ${title(roleChange.role)}. It takes effect the next time they load the app.`}
      </ConfirmDialog>
    </>
  )
}
