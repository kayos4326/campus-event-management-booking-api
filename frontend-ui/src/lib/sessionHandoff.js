// Every tab gets its own sessionStorage, so a second tab would normally start signed out
// and make you click through Microsoft again. Before MSAL starts, a new tab asks any
// other open tab for the session and copies it in.
//
// Why not localStorage (which is shared automatically)? It survives closing the browser,
// so on a shared lab computer the next student would find themselves signed in as you.
// Handing the session between live tabs keeps nothing on disk: when the last tab closes,
// the session is gone with it.
//
// Note: browsers can't tell a new tab from a new window — both share cookies and storage —
// so a new window of the same browser is also handed the session while a tab is open.
const CHANNEL = 'campus-events-session'
const WAIT_FOR_REPLY_MS = 400

const channel = () => ('BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null)

/** Answer other tabs that are starting up and need the session. */
export function shareSessionWithNewTabs() {
  const bus = channel()
  if (!bus) return
  bus.onmessage = (event) => {
    if (event.data?.type !== 'session:request') return
    if (sessionStorage.length === 0) return // this tab isn't signed in either
    bus.postMessage({ type: 'session:offer', payload: { ...sessionStorage } })
  }
}

/** Ask open tabs for the session. Resolves true if one answered in time. */
export function borrowSessionFromOpenTab() {
  const bus = channel()
  if (!bus || sessionStorage.length > 0) return Promise.resolve(false)

  return new Promise((resolve) => {
    const finish = (borrowed) => {
      clearTimeout(timer)
      bus.close()
      resolve(borrowed)
    }
    const timer = setTimeout(() => finish(false), WAIT_FOR_REPLY_MS)

    bus.onmessage = (event) => {
      if (event.data?.type !== 'session:offer') return
      Object.entries(event.data.payload).forEach(([key, value]) => sessionStorage.setItem(key, value))
      finish(true)
    }
    bus.postMessage({ type: 'session:request' })
  })
}
