import { useEffect, useState } from 'react'

export default function AdminPanel({ api, me }) {
  const [users, setUsers] = useState([])
  const [events, setEvents] = useState([])
  const [bookings, setBookings] = useState([])
  const [apiKeys, setApiKeys] = useState([])
  const [newKey, setNewKey] = useState(null)
  const [keyForm, setKeyForm] = useState({ ownerLabel: '', scope: 'room-status:read' })
  const [error, setError] = useState('')

  const loadAll = () => {
    // Confirmed directly: changing your OWN role away from ADMIN here makes this very
    // reload fail (you're no longer authorized for /admin/*) — without .catch(), that
    // failure was silent and the table just went stale with no explanation.
    api.get('/admin/users').then((res) => setUsers(res.data)).catch(() => setError(
      'Failed to load users — if you just changed your own role away from Admin, log out and back in.'
    ))
    api.get('/admin/events').then((res) => setEvents(res.data)).catch(() => {})
    api.get('/admin/bookings').then((res) => setBookings(res.data)).catch(() => {})
  }

  useEffect(() => { loadAll() }, [api])

  const changeRole = async (user, role) => {
    // These buttons used to act on a single click — one stray click is the likeliest
    // way Thar's own account ended up as ORGANIZER on 2026-09-10.
    if (!window.confirm(`Change ${user.displayName} from ${user.role} to ${role}?`)) return
    setError('')
    try {
      await api.patch(`/admin/users/${user.id}/role`, { role })
      loadAll()
    } catch (err) {
      setError(err.response?.data?.error || 'Role change failed')
    }
  }

  const issueKey = async (e) => {
    e.preventDefault()
    setError('')
    try {
      const res = await api.post('/admin/api-keys', keyForm)
      setNewKey(res.data)
      setApiKeys([...apiKeys, res.data])
      setKeyForm({ ownerLabel: '', scope: 'room-status:read' })
    } catch (err) {
      setError(err.response?.data?.error || 'Key issuance failed')
    }
  }

  const revokeKey = async (id) => {
    try {
      await api.delete(`/admin/api-keys/${id}`)
      setApiKeys(apiKeys.filter((k) => k.id !== id))
      setNewKey(null)
    } catch (err) {
      setError(err.response?.data?.error || 'Revoking the key failed')
    }
  }

  return (
    <div>
      <h2>Admin</h2>
      {error && <p className="error">{error}</p>}

      <section>
        <h3>Users</h3>
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Change to</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.displayName}</td>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>
                  {u.id === me?.id ? (
                    <span className="meta">That's you — another Admin has to change your role</span>
                  ) : (
                    ['STUDENT', 'ORGANIZER', 'ADMIN'].filter((r) => r !== u.role).map((r) => (
                      <button key={r} onClick={() => changeRole(u, r)}>{r}</button>
                    ))
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3>All Events ({events.length})</h3>
        <table className="table">
          <thead><tr><th>Title</th><th>Organizer</th><th>Status</th><th>Venue</th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{e.title}</td>
                <td>{e.organizer?.displayName}</td>
                <td>{e.status}</td>
                <td>{e.venue?.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3>All Bookings ({bookings.length})</h3>
        <table className="table">
          <thead><tr><th>Event</th><th>Student</th><th>Status</th></tr></thead>
          <tbody>
            {bookings.map((b) => (
              <tr key={b.id}>
                <td>{b.event?.title}</td>
                <td>{b.student?.displayName}</td>
                <td>{b.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Peer API Keys</h3>
        <p className="meta">Issue a key for the room-status endpoint (not tied to any specific team).</p>
        <form onSubmit={issueKey} className="form">
          <input placeholder="Owner label (free text)" required value={keyForm.ownerLabel}
            onChange={(e) => setKeyForm({ ...keyForm, ownerLabel: e.target.value })} />
          <input placeholder="Scope" required value={keyForm.scope}
            onChange={(e) => setKeyForm({ ...keyForm, scope: e.target.value })} />
          <button>Issue Key</button>
        </form>
        {newKey && (
          <div className="card">
            <p><strong>Save this now — it won't be shown again:</strong></p>
            <code className="key-display">{newKey.key}</code>
            <button onClick={() => revokeKey(newKey.id)}>Revoke</button>
          </div>
        )}
      </section>
    </div>
  )
}
