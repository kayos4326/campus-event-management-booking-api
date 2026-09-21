import { useCallback, useEffect, useRef, useState } from 'react'

const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll', 'wheel']

// Sign out an abandoned session. During the warning, only the button resets the timer.
export function useIdleTimeout({ idleMs, warnMs, onIdle }) {
  const [warningSeconds, setWarningSeconds] = useState(null)
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
    deadline.current = Date.now() + idleMs
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
