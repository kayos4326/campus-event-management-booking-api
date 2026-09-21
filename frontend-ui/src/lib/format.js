const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const dayYearFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short' })
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' })

const sameDay = (a, b) => a.toDateString() === b.toDateString()

const formatDay = (value) => dayFmt.format(new Date(value))
export const formatDate = (value) => dayYearFmt.format(new Date(value))
const formatTime = (value) => timeFmt.format(new Date(value))
export const monthShort = (value) => monthFmt.format(new Date(value))
export const weekdayShort = (value) => weekdayFmt.format(new Date(value))
export const dayOfMonth = (value) => new Date(value).getDate()

export function formatTimeRange(start, end) {
  const s = new Date(start)
  const e = new Date(end)
  if (sameDay(s, e)) return `${formatDay(s)} · ${formatTime(s)} – ${formatTime(e)}`
  return `${formatDay(s)}, ${formatTime(s)} – ${formatDay(e)}, ${formatTime(e)}`
}

export const isPast = (event) => new Date(event.endsAt) < new Date()

// Format a date for a datetime-local input.
export function toLocalInput(value) {
  if (!value) return ''
  const d = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Tidy names received from the AU directory.
export function cleanName(name = '') {
  const trimmed = name.replace(/[\s-]+$/, '').trim()
  if (trimmed && trimmed === trimmed.toUpperCase()) {
    return trimmed.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase())
  }
  return trimmed
}

export function initials(name = '') {
  const parts = cleanName(name).split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}

// Keep the same avatar color for each person.
export function hueFor(text = '') {
  let hash = 0
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) % 360
  return hash
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const STEPS = [['second', 60], ['minute', 60], ['hour', 24], ['day', 7], ['week', 4.35], ['month', 12], ['year', Infinity]]

export function timeAgo(value) {
  let amount = (new Date(value) - Date.now()) / 1000
  for (const [unit, size] of STEPS) {
    if (Math.abs(amount) < size) return relative.format(Math.round(amount), unit)
    amount /= size
  }
  return formatDate(value)
}

export const errorMessage = (err, fallback) => err?.response?.data?.error || fallback

export function seatInfo(event) {
  const confirmed = event.seats?.confirmed ?? 0
  const waitlisted = event.seats?.waitlisted ?? 0
  const left = Math.max(0, event.capacity - confirmed)
  return { confirmed, waitlisted, left, full: left === 0, ratio: event.capacity ? confirmed / event.capacity : 0 }
}
