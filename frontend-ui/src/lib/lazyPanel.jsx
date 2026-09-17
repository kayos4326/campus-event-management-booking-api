import { lazy, useState } from 'react'

// A page whose code downloads on demand, with `.preload()` to fetch it ahead of time.
// React.lazy shows its fallback for a frame even when the code is already here, so a
// preloaded page would still flash a skeleton; once the module is in, it renders directly.
export function lazyPanel(loader) {
  let loaded = null
  const load = () => loader().then((module) => { loaded = module; return module })
  const Lazy = lazy(load)
  function Panel(props) {
    // Decided once per mount: swapping the component type later would remount the page and
    // lose what's on it (an open dialog, a half-filled form).
    const [Ready] = useState(() => loaded?.default ?? null)
    return Ready ? <Ready {...props} /> : <Lazy {...props} />
  }
  Panel.preload = () => load().catch(() => {}) // a failure is handled when the page is opened
  return Panel
}
