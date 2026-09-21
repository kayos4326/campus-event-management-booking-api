// Share the MSAL session with other open tabs, but not after the browser closes.
const CHANNEL = 'campus-events-session'
const WAIT_FOR_REPLY_MS = 400

const channel = () => ('BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null)

// Send this tab's session to a newly opened tab.
export function shareSessionWithNewTabs() {
  const bus = channel()
  if (!bus) return
  bus.onmessage = (event) => {
    if (event.data?.type !== 'session:request') return
    if (sessionStorage.length === 0) return
    bus.postMessage({ type: 'session:offer', payload: { ...sessionStorage } })
  }
}

// Ask another open tab for its session before MSAL starts.
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
