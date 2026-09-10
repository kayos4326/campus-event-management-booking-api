import { useEffect, useMemo, useState } from 'react'
import { useMsal, useIsAuthenticated } from '@azure/msal-react'
import { loginRequest } from './authConfig'
import { createApiClient } from './api'
import EventsBrowse from './components/EventsBrowse'
import MyBookings from './components/MyBookings'
import OrganizerPanel from './components/OrganizerPanel'
import AdminPanel from './components/AdminPanel'

const TABS_BY_ROLE = {
  STUDENT: [
    ['events', 'Events'],
    ['bookings', 'My Bookings'],
  ],
  ORGANIZER: [
    ['events', 'Events'],
    ['organizer', 'My Events'],
  ],
  ADMIN: [
    ['events', 'Events'],
    ['admin', 'Admin'],
  ],
}

function App() {
  const { instance, accounts } = useMsal()
  const isAuthenticated = useIsAuthenticated()
  const account = accounts[0]

  const [me, setMe] = useState(null)
  const [tab, setTab] = useState('events')

  const api = useMemo(
    () => (account ? createApiClient(instance, account) : null),
    [instance, account],
  )

  useEffect(() => {
    if (!api) return
    api.get('/me').then((res) => setMe(res.data)).catch(() => setMe(null))
  }, [api])

  if (!isAuthenticated) {
    return (
      <div className="centered">
        <h1>Campus Event Booking</h1>
        <p>Log in with your university Microsoft account to continue.</p>
        <button onClick={() => instance.loginRedirect(loginRequest)}>Log in</button>
      </div>
    )
  }

  if (!me) {
    return <div className="centered">Loading your account…</div>
  }

  const tabs = TABS_BY_ROLE[me.role] || TABS_BY_ROLE.STUDENT

  return (
    <div className="app">
      <header className="topbar">
        <h1>Campus Event Booking</h1>
        <div className="who">
          {me.displayName} <span className="role-badge">{me.role}</span>
          <button className="link" onClick={() => instance.logoutRedirect()}>Log out</button>
        </div>
      </header>

      <nav className="tabs">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            className={tab === key ? 'tab active' : 'tab'}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="content">
        {tab === 'events' && <EventsBrowse api={api} role={me.role} />}
        {tab === 'bookings' && me.role === 'STUDENT' && <MyBookings api={api} />}
        {tab === 'organizer' && me.role === 'ORGANIZER' && <OrganizerPanel api={api} />}
        {tab === 'admin' && me.role === 'ADMIN' && <AdminPanel api={api} />}
      </main>
    </div>
  )
}

export default App
