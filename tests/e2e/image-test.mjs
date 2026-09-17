// Cover-image checks against the real app + real MySQL (see README.md).
// Seeds a venue and events directly (venue creation calls Geoapify, which this run
// doesn't need), then exercises every image endpoint over HTTP.
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const API = process.env.API || 'http://127.0.0.1:3998/events/api'
const APP_DIR = process.env.APP_DIR
if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto
const { prisma } = require(`${APP_DIR}/src/services/prisma`)

let passed = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const call = (path, { token, method = 'GET', body, type } = {}) =>
  fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(type ? { 'Content-Type': type } : body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: type ? body : body ? JSON.stringify(body) : undefined,
  })

const json = async (path, opts) => {
  const res = await call(path, opts)
  return { status: res.status, body: await res.json().catch(() => null) }
}

// A real, minimal PNG (1x1) and JPEG built by hand — no fixture files to ship.
const crc = (buf) => {
  let c = ~0
  for (const byte of buf) { c ^= byte; for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
  return ~c >>> 0
}
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data])
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body))
  return Buffer.concat([len, body, sum])
}
const png = (r, g, b) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, r, g, b]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const JPEG = Buffer.concat([Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'), Buffer.alloc(2048, 0x5a), Buffer.from('ffd9', 'hex')])
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

async function main() {
  const org = await prisma.user.findUnique({ where: { adObjectId: 'e2e-org' } })
  const org2 = await prisma.user.findUnique({ where: { adObjectId: 'e2e-org2' } })
  const venue = await prisma.venue.create({
    data: { name: '[E2E] Image Hall', roomNumber: 'IMG1', addressRaw: 'Campus', latitude: 13.6138, longitude: 100.8338, isVerified: true },
  })
  const makeEvent = (title, status) => prisma.event.create({
    data: {
      title, status, capacity: 10, organizerId: org.id, venueId: venue.id,
      startsAt: new Date(Date.now() + 864e5), endsAt: new Date(Date.now() + 864e5 + 72e5),
    },
  })
  const event = await makeEvent('[E2E] Poster event', 'PUBLISHED')
  const draft = await makeEvent('[E2E] Draft poster', 'DRAFT')
  const otherEvent = await prisma.event.create({
    data: {
      title: '[E2E] Someone else', status: 'PUBLISHED', capacity: 5, organizerId: org2.id, venueId: venue.id,
      startsAt: new Date(Date.now() + 864e5), endsAt: new Date(Date.now() + 864e5 + 72e5),
    },
  })

  console.log('\nUpload')
  const original = png(220, 90, 30)
  const up = await json(`/events/${event.id}/image`, { token: 'e2e-org', method: 'POST', body: original, type: 'image/png' })
  check('organizer uploads a PNG', up.status === 201, `status ${up.status}`)
  check('response carries the image URL', /^\/events\/api\/events\/\d+\/image\/[0-9a-f]{24}$/.test(up.body?.imageUrl || ''), up.body?.imageUrl)

  console.log('\nServing')
  const served = await fetch(`${API.replace('/events/api', '')}${up.body.imageUrl}`)
  const bytes = Buffer.from(await served.arrayBuffer())
  check('served without any token', served.status === 200, `status ${served.status}`)
  check('bytes survive the round trip through LONGBLOB', sha(bytes) === sha(original), `${bytes.length}B vs ${original.length}B`)
  check('content type is the stored one', served.headers.get('content-type')?.includes('image/png'), served.headers.get('content-type'))
  check('cached immutably', (served.headers.get('cache-control') || '').includes('immutable'))

  const guessed = await fetch(`${API}/events/${event.id}/image/${'0'.repeat(24)}`)
  check('a guessed key is a 404', guessed.status === 404, `status ${guessed.status}`)
  const wrongEvent = await fetch(`${API}/events/${otherEvent.id}/image/${up.body.imageUrl.split('/').pop()}`)
  check('a real key on the wrong event is a 404', wrongEvent.status === 404, `status ${wrongEvent.status}`)

  console.log('\nListing')
  const browse = await json('/events', { token: 'e2e-s1' })
  const listed = browse.body.find((e) => e.id === event.id)
  check('browse returns the image URL', listed?.imageUrl === up.body.imageUrl, listed?.imageUrl)
  check('the raw key is not exposed', listed && !('image' in listed))
  const noPoster = browse.body.find((e) => e.id === otherEvent.id)
  check('an event without a poster reports null', noPoster?.imageUrl === null, String(noPoster?.imageUrl))

  console.log('\nDrafts')
  const draftUp = await json(`/events/${draft.id}/image`, { token: 'e2e-org', method: 'POST', body: JPEG, type: 'image/jpeg' })
  check('a draft can have a poster', draftUp.status === 201, `status ${draftUp.status}`)
  check("a student's browse doesn't list the draft", !browse.body.some((e) => e.id === draft.id))
  const mine = await json('/events?mine=true', { token: 'e2e-org' })
  check('the organizer sees the draft poster', mine.body.find((e) => e.id === draft.id)?.imageUrl === draftUp.body.imageUrl)

  console.log('\nReplacing and removing')
  const replaced = await json(`/events/${event.id}/image`, { token: 'e2e-org', method: 'POST', body: JPEG, type: 'image/jpeg' })
  check('replacing mints a new URL', replaced.body.imageUrl !== up.body.imageUrl, replaced.body?.imageUrl)
  check('the old URL stops working', (await fetch(`${API.replace('/events/api', '')}${up.body.imageUrl}`)).status === 404)
  const newBytes = Buffer.from(await (await fetch(`${API.replace('/events/api', '')}${replaced.body.imageUrl}`)).arrayBuffer())
  check('the new URL serves the new image', sha(newBytes) === sha(JPEG))
  check('only one row per event', (await prisma.eventImage.count({ where: { eventId: event.id } })) === 1)

  const removed = await json(`/events/${event.id}/image`, { token: 'e2e-org', method: 'DELETE' })
  check('the organizer removes the poster', removed.status === 200, `status ${removed.status}`)
  check('the row is gone', (await prisma.eventImage.count({ where: { eventId: event.id } })) === 0)
  check('removing again is still fine', (await json(`/events/${event.id}/image`, { token: 'e2e-org', method: 'DELETE' })).status === 200)

  console.log('\nWho may upload')
  check('a student may not', (await json(`/events/${event.id}/image`, { token: 'e2e-s1', method: 'POST', body: JPEG, type: 'image/jpeg' })).status === 403)
  check("another organizer may not", (await json(`/events/${event.id}/image`, { token: 'e2e-org2', method: 'POST', body: JPEG, type: 'image/jpeg' })).status === 403)
  check("another organizer may not remove", (await json(`/events/${event.id}/image`, { token: 'e2e-org2', method: 'DELETE' })).status === 403)
  check('an admin may', (await json(`/events/${event.id}/image`, { token: 'e2e-admin', method: 'POST', body: JPEG, type: 'image/jpeg' })).status === 201)
  check('no token is a 401', (await json(`/events/${event.id}/image`, { method: 'POST', body: JPEG, type: 'image/jpeg' })).status === 401)

  console.log('\nWhat may be uploaded')
  const fake = Buffer.concat([Buffer.from('<?php system($_GET[0]); ?>'), Buffer.alloc(64, 1)])
  check('a script claiming to be a JPEG is rejected', (await json(`/events/${event.id}/image`, { token: 'e2e-org', method: 'POST', body: fake, type: 'image/jpeg' })).status === 400)
  check('an unsupported type is rejected', [400, 415].includes((await json(`/events/${event.id}/image`, { token: 'e2e-org', method: 'POST', body: fake, type: 'application/pdf' })).status))
  const huge = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(3 * 1024 * 1024, 7)])
  check('an oversized file is a 413', (await json(`/events/${event.id}/image`, { token: 'e2e-org', method: 'POST', body: huge, type: 'image/jpeg' })).status === 413)
  check('a missing event is a 404', (await json('/events/99999999/image', { token: 'e2e-admin', method: 'POST', body: JPEG, type: 'image/jpeg' })).status === 404)

  console.log('\nBookings carry the poster')
  await json('/bookings', { token: 'e2e-s1', method: 'POST', body: { eventId: event.id } })
  const bookings = await json('/bookings/mine', { token: 'e2e-s1' })
  check('a ticket knows its event image', typeof bookings.body[0]?.event?.imageUrl === 'string', String(bookings.body[0]?.event?.imageUrl))

  console.log('\nCascade')
  const before = await prisma.eventImage.count()
  await prisma.booking.deleteMany({ where: { eventId: { in: [event.id, draft.id, otherEvent.id] } } })
  await prisma.event.deleteMany({ where: { id: { in: [event.id, draft.id, otherEvent.id] } } })
  check('deleting an event takes its image with it', (await prisma.eventImage.count()) === before - 2, `${before} → ${await prisma.eventImage.count()}`)
  await prisma.venue.delete({ where: { id: venue.id } })
  await prisma.auditLog.deleteMany({ where: { actorLabel: { startsWith: 'E2E ' } } })

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) { failures.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1) }
}

main().catch((err) => { console.error(err); process.exit(1) })
