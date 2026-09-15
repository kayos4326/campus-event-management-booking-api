import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMsal, useIsAuthenticated } from '@azure/msal-react'
import { CalendarDays, Compass, Hourglass, LayoutDashboard, LogOut, MapPin, ShieldCheck, Ticket } from 'lucide-react'
import { loginRequest } from './authConfig'
import { createApiClient } from './api'
import EventsBrowse from './components/EventsBrowse'
import MyBookings from './components/MyBookings'
import OrganizerPanel from './components/OrganizerPanel'
import AdminPanel from './components/AdminPanel'
import { Avatar, Brand, RolePill, Spinner, ToastProvider } from './components/ui'
import { cleanName } from './lib/format'

const TABS = {
  events: { label: 'Discover', icon: Compass },
  bookings: { label: 'My bookings', icon: Ticket },
  organizer: { label: 'My events', icon: LayoutDashboard },
  admin: { label: 'Admin', icon: ShieldCheck },
}

// Admins can do everything an Organizer can (the API allows it), and role priority
// means anyone holding both app roles resolves to ADMIN — so they need My events too.
const TABS_BY_ROLE = {
  STUDENT: ['events', 'bookings'],
  ORGANIZER: ['events', 'organizer'],
  ADMIN: ['events', 'organizer', 'admin'],
}

function SignIn({ onSignIn }) {
  return (
    <div className="auth">
      <section className="auth-hero">
        <Brand />
        <div className="auth-copy">
          <span className="eyebrow">For students &amp; campus organizers</span>
          <h1>Every campus event, <em>one seat</em> away.</h1>
          <p>Browse what's on, reserve a seat in one click, and get moved off the waitlist automatically when a spot opens up.</p>
          <ul className="auth-features">
            <li><span className="icon-tile"><Ticket /></span> Reserve seats in one click</li>
            <li><span className="icon-tile"><Hourglass /></span> Automatic waitlist when an event fills up</li>
            <li><span className="icon-tile"><MapPin /></span> Verified venues with maps</li>
          </ul>
        </div>
        <div className="hero-ticket" aria-hidden="true">
          <div className="ticket-stub">
            <span>Seat</span>
            <strong>A1</strong>
            <small>Admit one</small>
          </div>
          <div className="hero-ticket-body">
            <strong>Your seat is confirmed</strong>
            <span><CalendarDays size={13} style={{ verticalAlign: '-2px' }} /> Shows up here the moment you book</span>
          </div>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <h2>Sign in</h2>
          <p>Use your university Microsoft account to continue.</p>
          <button className="btn btn-microsoft btn-block" onClick={onSignIn}>
            <span className="ms-logo" aria-hidden="true">
              <i style={{ background: '#f25022' }} /><i style={{ background: '#7fba00' }} />
              <i style={{ background: '#00a4ef' }} /><i style={{ background: '#ffb900' }} />
            </span>
            Sign in with Microsoft
          </button>
          <div className="role-legend">
            <div><RolePill role="STUDENT" /> Browse events and reserve seats</div>
            <div><RolePill role="ORGANIZER" /> Create venues and run events</div>
            <div><RolePill role="ADMIN" /> Manage people, events and API keys</div>
          </div>
        </div>
      </section>
    </div>
  )
}

function App() {
  const { instance, accounts } = useMsal()
  const isAuthenticated = useIsAuthenticated()
  const account = accounts[0]

  const [me, setMe] = useState(null)
  const [meError, setMeError] = useState(false)
  // The tab lives in the URL (#bookings, #admin…) so refresh, Back/Forward and shared links
  // keep your place — a reload used to always drop you back on Discover.
  const [tab, setTab] = useState(() => window.location.hash.slice(1) || 'events')

  useEffect(() => {
    const onHashChange = () => setTab(window.location.hash.slice(1) || 'events')
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const goTo = (key) => {
    setTab(key)
    if (window.location.hash !== `#${key}`) window.location.hash = key
  }

  // Keyed on the account's id rather than the account object: every page reloads its data
  // when `api` changes, so a new-but-identical account object must not rebuild the client
  // (found in e2e testing — it caused an endless refetch loop, ~20 requests a second).
  const accountKey = account?.homeAccountId || account?.username || null
  const api = useMemo(
    () => (account ? createApiClient(instance, account) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [instance, accountKey],
  )

  const loadMe = useCallback(() => {
    if (!api) return
    api.get('/me')
      .then((res) => { setMe(res.data); setMeError(false) })
      .catch(() => setMeError(true))
  }, [api])

  useEffect(() => { loadMe() }, [loadMe])

  if (!isAuthenticated) {
    return <SignIn onSignIn={() => instance.loginRedirect(loginRequest)} />
  }

  if (!me) {
    return (
      <div className="center-screen">
        {meError ? (
          <div className="stack">
            <h2>We couldn't load your account</h2>
            <p style={{ color: 'var(--text-2)' }}>Check your connection and try again.</p>
            <div className="page-actions">
              <button className="btn btn-primary" onClick={() => { setMeError(false); loadMe() }}>Try again</button>
              <button className="btn" onClick={() => instance.logoutRedirect()}>Sign out</button>
            </div>
          </div>
        ) : (
          <div className="stack">
            <Spinner className="loader" />
            <p style={{ color: 'var(--text-2)' }}>Loading your account…</p>
          </div>
        )}
      </div>
    )
  }

  const tabs = TABS_BY_ROLE[me.role] || TABS_BY_ROLE.STUDENT
  const activeTab = tabs.includes(tab) ? tab : 'events'

  return (
    <ToastProvider>
      <header className="topbar">
        <div className="topbar-inner">
          <Brand />
          <nav className="nav" aria-label="Main">
            {tabs.map((key) => {
              const { label, icon: Icon } = TABS[key]
              return (
                <button
                  key={key}
                  aria-current={activeTab === key ? 'page' : undefined}
                  onClick={() => goTo(key)}
                >
                  <Icon /> {label}
                </button>
              )
            })}
          </nav>
          <div className="user-chip">
            <div className="user-chip-text">
              <strong>{cleanName(me.displayName)}</strong>
              <span>{me.role[0] + me.role.slice(1).toLowerCase()}</span>
            </div>
            <Avatar name={me.displayName} />
            <button
              className="btn btn-ghost btn-icon"
              onClick={() => instance.logoutRedirect()}
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut />
            </button>
          </div>
        </div>
      </header>

      <main className="page">
        {activeTab === 'events' && <EventsBrowse api={api} role={me.role} onGoToBookings={() => goTo('bookings')} />}
        {activeTab === 'bookings' && <MyBookings api={api} onBrowse={() => goTo('events')} />}
        {activeTab === 'organizer' && <OrganizerPanel api={api} />}
        {activeTab === 'admin' && <AdminPanel api={api} me={me} />}
      </main>
    </ToastProvider>
  )
}

export default App
