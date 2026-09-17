import { Component, Suspense } from 'react'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import { EmptyState } from './ui'

// A tab opened before a deploy asks for code files the new release doesn't have. main.jsx
// reloads once when that happens; if it happens again, the page lands here instead.
const isStaleCode = (error) =>
  /dynamically imported module|Importing a module script failed|error loading dynamically imported|Failed to fetch/i
    .test(String(error?.message || error))

// Shown while a panel's code downloads — shaped like a page, so nothing jumps when it arrives.
function PanelLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Loading…</span>
      <div className="page-header">
        <div style={{ display: 'grid', gap: 10 }}>
          <div className="skeleton" style={{ width: 220, height: 34 }} />
          <div className="skeleton" style={{ width: 320, height: 16 }} />
        </div>
      </div>
      <div className="manage-list">
        {[0, 1].map((i) => <div key={i} className="skeleton skeleton-row" />)}
      </div>
    </div>
  )
}

class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const reload = <button className="btn btn-primary" onClick={() => window.location.reload()}><RefreshCw /> Reload</button>
    return isStaleCode(error) ? (
      <EmptyState icon={RefreshCw} title="Campus Events was just updated" action={reload}>
        Reload to get the new version. You'll stay signed in.
      </EmptyState>
    ) : (
      <EmptyState icon={TriangleAlert} title="This page ran into a problem" action={reload}>
        Reloading usually fixes it. If it keeps happening, tell the team what you were doing.
      </EmptyState>
    )
  }
}

// Wraps a page that's loaded on demand: a placeholder while it downloads, and
// a way out if it can't load or crashes, instead of a blank screen.
export default function PanelBoundary({ children }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<PanelLoading />}>{children}</Suspense>
    </ErrorBoundary>
  )
}
