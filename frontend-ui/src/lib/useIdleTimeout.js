import { useCallback, useEffect, useRef, useState } from 'react'

// Anything that proves a person is still at the computer.
const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll', 'wheel']

/**
 * Shared-computer safety: an abandoned tab signs itself out.
 * Activity keeps pushing the deadline back, but once the warning is showing only an
 * explicit "Stay signed in" resets it — a passing mouse shouldn't keep a session alive.
 */
export function useIdleTimeout({ idleMs, warnMs, onIdle }) {
  const [warningSeconds, setWarningSeconds] = useState(null) // null while there's no warning
  const deadline = useRef(0)
  const warning = useRef(false)
  const onIdleRef = useRef(onIdle)
  useEffect(() => { onIdleRef.current = onIdle })

  const stayActive = useCallback(() => {
    deadline.current = Date.now() + idleMs
    warning.current = false
    setWarningSeconds(null)
  }, [idleMs])

  useEffect(() => {
    deadline.current = Date.now() + idleMs // start the clock on mount, not during render
    const onActivity = () => { if (!warning.current) stayActive() }
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }))

    const tick = setInterval(() => {
      const left = deadline.current - Date.now()
      if (left <= 0) {
        clearInterval(tick)
        onIdleRef.current?.()
      } else if (left <= warnMs) {
        warning.current = true
        setWarningSeconds(Math.ceil(left / 1000))
      }
    }, 500)

    return () => {
      clearInterval(tick)
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity))
    }
  }, [idleMs, warnMs, stayActive])

  return { warningSeconds, stayActive }
}
