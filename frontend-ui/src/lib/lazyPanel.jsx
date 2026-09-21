import { lazy, useState } from 'react'

// Lazy-load large panels and allow them to be preloaded after login.
export function lazyPanel(loader) {
  let loaded = null
  const load = () => loader().then((module) => { loaded = module; return module })
  const Lazy = lazy(load)
  function Panel(props) {
    // Keep the same component while this panel is mounted.
    const [Ready] = useState(() => loaded?.default ?? null)
    return Ready ? <Ready {...props} /> : <Lazy {...props} />
  }
  Panel.preload = () => load().catch(() => {})
  return Panel
}
