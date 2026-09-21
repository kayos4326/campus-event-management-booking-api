import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, LoaderCircle, TicketCheck, TriangleAlert, X } from 'lucide-react'
import { cleanName, dayOfMonth, hueFor, initials, monthShort, seatInfo } from '../lib/format'

export function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark"><TicketCheck strokeWidth={2.4} /></span>
      Campus Events
    </span>
  )
}

export function Spinner({ className = '' }) {
  return <LoaderCircle className={`spin ${className}`} aria-hidden="true" />
}

export function Avatar({ name, size }) {
  return (
    <span
      className={`avatar ${size === 'sm' ? 'avatar-sm' : ''}`}
      style={{ '--avatar-hue': hueFor(name) }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  )
}

export function Person({ name, email }) {
  return (
    <div className="person">
      <Avatar name={name} size="sm" />
      <div>
        <strong>{cleanName(name)}</strong>
        {email && <span>{email}</span>}
      </div>
    </div>
  )
}

const STATUS_PILLS = {
  CONFIRMED: ['pill-success', 'Confirmed'],
  WAITLISTED: ['pill-warning', 'Waitlisted'],
  CANCELLED: ['pill-danger', 'Cancelled'],
  PUBLISHED: ['pill-success', 'Published'],
  DRAFT: ['pill-neutral', 'Draft'],
  ENDED: ['pill-neutral', 'Ended'],
}

export function StatusPill({ status, label }) {
  const [tone, text] = STATUS_PILLS[status] || ['pill-neutral', status]
  return <span className={`pill ${tone}`}>{label || text}</span>
}

const ROLE_PILLS = { ADMIN: 'pill-accent', ORGANIZER: 'pill-info', STUDENT: 'pill-neutral' }

export function RolePill({ role }) {
  return <span className={`pill no-dot ${ROLE_PILLS[role] || 'pill-neutral'}`}>{role[0] + role.slice(1).toLowerCase()}</span>
}

export function DateBadge({ date, muted }) {
  return (
    <div className={`date-badge ${muted ? 'muted' : ''}`}>
      <span>{monthShort(date)}</span>
      <strong>{dayOfMonth(date)}</strong>
    </div>
  )
}

export function CapacityBar({ event }) {
  const { confirmed, waitlisted, left, full, ratio } = seatInfo(event)
  const tone = full ? 'full' : ratio >= 0.75 ? 'hot' : ''
  return (
    <div className="capacity">
      <div className="capacity-labels">
        <strong>{confirmed} / {event.capacity} booked</strong>
        {full ? (
          <span className="full">Full{waitlisted > 0 ? ` · ${waitlisted} waiting` : ''}</span>
        ) : (
          <span className={tone}>{left} {left === 1 ? 'seat' : 'seats'} left</span>
        )}
      </div>
      <div
        className="capacity-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={event.capacity}
        aria-valuenow={confirmed}
        aria-label="Seats booked"
      >
        <div className={`capacity-fill ${tone}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
    </div>
  )
}

export function EmptyState({ icon: Icon, title, children, action }) {
  return (
    <div className="empty">
      <span className="icon-tile accent"><Icon /></span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

export function Segmented({ options, value, onChange, label }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
          {opt.count !== undefined && <span className="count">{opt.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function StatCard({ icon: Icon, tone, value, label }) {
  return (
    <div className="card stat">
      <span className={`icon-tile ${tone || ''}`}><Icon /></span>
      <div>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  )
}

export function Alert({ children, tone = 'danger' }) {
  return (
    <div className={`alert alert-${tone}`} role="alert">
      <CircleAlert />
      <div>{children}</div>
    </div>
  )
}

// Native dialog handles focus, Escape and the backdrop.
export function Modal({ open, onClose, title, description, size, children, footer }) {
  const ref = useRef(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      // Start on the first form field instead of the close button.
      dialog.querySelector('.modal-body input:not([disabled]), .modal-body textarea, .modal-body select')?.focus()
    }
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className={`modal ${size || ''}`}
      onCancel={(e) => { e.preventDefault(); onClose() }}
      onMouseDown={(e) => { if (e.target === ref.current) onClose() }}
    >
      {open && (
        <div className="modal-inner">
          <div className="modal-head">
            <div>
              <h2>{title}</h2>
              {description && <p>{description}</p>}
            </div>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close">
              <X />
            </button>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </div>
      )}
    </dialog>
  )
}

export function ConfirmDialog({ open, title, children, confirmLabel, danger, busy, onConfirm, onClose }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="narrow"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Keep it</button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy && <Spinner />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ color: 'var(--text-2)' }}>{children}</p>
    </Modal>
  )
}

const ToastContext = createContext(() => {})

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const push = useCallback((toast) => {
    const id = Math.random().toString(36).slice(2)
    setToasts((list) => [...list, { id, tone: 'success', ...toast }])
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), toast.duration || 4500)
  }, [])

  const icons = { success: CircleCheck, warning: TriangleAlert, danger: CircleAlert }

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => {
          const Icon = icons[t.tone] || CircleCheck
          return (
            <div key={t.id} className={`toast ${t.tone}`}>
              <Icon />
              <div>
                <strong>{t.title}</strong>
                {t.body && <span>{t.body}</span>}
              </div>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)
