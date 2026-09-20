// Open tabs share the in-memory MSAL session through BroadcastChannel. Unlike localStorage,
// nothing survives after the final browser tab closes on a shared computer.
const CHANNEL = 'campus-events-session'
const WAIT_FOR_REPLY_MS = 400

const channel = () => ('BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null)

// Answer another tab that requests the current session.
export function shareSessionWithNewTabs() {
  const bus = channel()
  if (!bus) return
  bus.onmessage = (event) => {
    if (event.data?.type !== 'session:request') return
    if (sessionStorage.length === 0) return // this tab isn't signed in either
    bus.postMessage({ type: 'session:offer', payload: { ...sessionStorage } })
  }
}

// Borrow a session from an open tab before MSAL initializes.
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
