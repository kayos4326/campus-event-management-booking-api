// Cover images end to end in a real Google Chrome window: pick a file in the event form,
// watch it get resized and uploaded, and check it renders for the student afterwards.
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const SP = new URL('.', import.meta.url).pathname
const APP = 'http://127.0.0.1:4173/events/'
const SHOTS = `${SP}ui-shots`
const APP_DIR = process.env.APP_DIR
if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto
const { prisma } = require(`${APP_DIR}/src/services/prisma`)

fs.mkdirSync(SHOTS, { recursive: true })

const results = []
const consoleErrors = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`)
}

// A real 1200x675 PNG, drawn here so the suite ships no binary fixture.
function poster(file) {
  const W = 1200, H = 675
  const raw = Buffer.alloc((W * 3 + 1) * H)
  let p = 0
  for (let y = 0; y < H; y += 1) {
    raw[p] = 0; p += 1
    for (let x = 0; x < W; x += 1) {
      const band = Math.floor(y / 96) % 2
      raw[p] = 230 - Math.round((x / W) * 120) + band * 12
      raw[p + 1] = 90 + Math.round((y / H) * 70)
      raw[p + 2] = 40 + Math.round((x / W) * 60)
      p += 3
    }
  }
  const crc = (buf) => {
    let c = ~0
    for (const b of buf) { c ^= b; for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
    return ~c >>> 0
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]))
  return fs.statSync(file).size
}

const posterPath = `${SP}poster.png`
const posterBytes = poster(posterPath)
console.log(`test poster: ${(posterBytes / 1024).toFixed(0)} KB, 1200x675`)

const org = await prisma.user.findUnique({ where: { adObjectId: 'e2e-org' } })
const venue = await prisma.venue.create({
  data: { name: '[E2E] Poster Hall', roomNumber: 'P1', addressRaw: 'Campus', latitude: 13.6138, longitude: 100.8338, isVerified: true },
})

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  slowMo: 12,
  userDataDir: `${SP}chrome-profile`,
  defaultViewport: { width: 1366, height: 900 },
  args: ['--window-size=1400,1020', '--no-first-run', '--no-default-browser-check'],
})
const page = (await browser.pages())[0] || (await browser.newPage())
page.setDefaultTimeout(20000)
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(`PAGE ERROR: ${e.message}`))

let shotN = 0
const shot = async (name) => {
  shotN += 1
  await page.screenshot({ path: `${SHOTS}/img-${String(shotN).padStart(2, '0')}-${name}.png`, fullPage: true }).catch(() => {})
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const settle = () => page.waitForNetworkIdle({ idleTime: 250, timeout: 5000 }).catch(() => {})
const waitText = (t, timeout = 10000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, t)

async function signInAs(user) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.evaluate((u) => sessionStorage.setItem('e2eUser', u), user)
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('nav') && document.querySelector('.page-header h1'))
  await settle()
}
const clickText = async (text) => {
  const handle = await page.evaluateHandle((t) => {
    const root = document.querySelector('dialog[open]') || document
    return [...root.querySelectorAll('button, a')].find((b) => b.innerText.trim() === t && b.offsetParent !== null)
  }, text)
  const el = handle.asElement()
  if (!el) throw new Error(`no button "${text}"`)
  await el.click()
}
const goTab = async (hash) => { await page.goto(`${APP}#${hash}`, { waitUntil: 'domcontentloaded' }); await settle() }
// An <img> that actually decoded has a naturalWidth; a broken one is 0. Waits for it, since
// the request only starts once the element is on the page.
const imageLoaded = (selector, timeout = 10000) =>
  page.waitForFunction((sel) => {
    const el = document.querySelector(sel)
    return !!el && el.complete && el.naturalWidth > 0
  }, { timeout }, selector).then(() => true, () => false)
// Scoped to this run's own event, so leftovers from other suites can't be mistaken for it.
const cardSelector = async (cardClass, title) => {
  const index = await page.evaluate((cls, t) => [...document.querySelectorAll(cls)].findIndex((c) => c.innerText.includes(t)), cardClass, title)
  return index < 0 ? null : `${cardClass}:nth-of-type(${index + 1})`
}

const title = `[E2E] Poster ${Date.now()}`

try {
  // ------------------------------------------------------------------ organizer uploads
  await signInAs('e2e-org')
  await goTab('organizer')
  await clickText('New event')
  await page.waitForSelector('dialog[open] .image-drop')
  check('the create form offers a cover image', true)
  await shot('form-empty')

  const input = await page.$('dialog[open] input[type=file]')
  await input.uploadFile(posterPath)
  await page.waitForSelector('dialog[open] .image-preview img', { timeout: 15000 })
  check('the picked file previews in the form', await imageLoaded('dialog[open] .image-preview img'))
  await shot('form-preview')

  await page.type('dialog[open] input[placeholder^="e.g. Career Fair"]', title)
  // React listens to its own value setter, so a plain el.value = … is ignored.
  await page.evaluate((venueId) => {
    const set = (el, value) => {
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const dialog = document.querySelector('dialog[open]')
    const [starts, ends] = dialog.querySelectorAll('input[type=datetime-local]')
    set(starts, '2026-12-20T10:00')
    set(ends, '2026-12-20T12:00')
    set(dialog.querySelector('#event-venue'), String(venueId))
  }, venue.id)
  await clickText('Publish event')
  await waitText('Event published')
  await settle()
  check('the event saved with its image', true)

  const ownRow = await cardSelector('.manage-card', title)
  // Thumbnails load lazily, and with a long list this row can start off screen.
  await page.$eval(ownRow, (el) => el.scrollIntoView({ block: 'center' }))
  check('the organizer list shows a thumbnail', ownRow && await imageLoaded(`${ownRow} .manage-thumb`), ownRow)
  await shot('organizer-list')

  const saved = await prisma.event.findFirst({ where: { title }, include: { image: true } })
  check('the image reached the database', !!saved?.image, saved?.image ? `${saved.image.bytes.length} bytes` : 'none')
  check('the browser resized it before uploading', saved.image.bytes.length < posterBytes, `${posterBytes} → ${saved?.image?.bytes.length}`)
  check('it was re-encoded as JPEG', saved.image.mimeType === 'image/jpeg', saved?.image?.mimeType)

  // ------------------------------------------------------------------ the student's view
  await signInAs('e2e-s1')
  await waitText(title)
  const ownCard = await cardSelector('.event-card', title)
  await page.$eval(ownCard, (el) => el.scrollIntoView({ block: 'center' })) // images load lazily, when on screen
  const loaded = await imageLoaded(`${ownCard} .event-media img`)
  const card = await page.evaluate((t) => {
    const el = [...document.querySelectorAll('.event-card')].find((c) => c.innerText.includes(t))
    const badge = el?.querySelector('.event-media .date-badge')
    return {
      hasPhoto: !!el?.querySelector('.event-media.has-photo'),
      fallback: !!el?.querySelector('.media-fallback'),
      badgeOnTop: !!badge && badge.getBoundingClientRect().width > 0,
    }
  }, title)
  check('the student sees the photo on the event card', loaded, card)
  check('the photo replaces the placeholder pattern', card.hasPhoto && !card.fallback, card)
  check('the date badge still sits on top of it', card.badgeOnTop, card)
  await shot('student-discover')

  await page.evaluate((t) => {
    const el = [...document.querySelectorAll('.event-card')].find((c) => c.innerText.includes(t))
    el.querySelector('footer button').click()
  }, title)
  await waitText('Seat reserved')
  await goTab('bookings')
  await waitText(title)
  const ownTicket = await cardSelector('.ticket', title)
  check('the booking ticket shows the photo', ownTicket && await imageLoaded(`${ownTicket} .ticket-photo`), ownTicket)
  await shot('student-ticket')

  // ------------------------------------------------------------------ replacing/removing
  await signInAs('e2e-org')
  await goTab('organizer')
  await waitText(title)
  // This run's own event, not whichever card happens to come first.
  await page.evaluate((t) => {
    const row = [...document.querySelectorAll('.manage-card')].find((c) => c.innerText.includes(t))
    ;[...row.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Edit').click()
  }, title)
  await page.waitForSelector('dialog[open] .image-preview img')
  check('editing shows the image already saved', await imageLoaded('dialog[open] .image-preview img'))
  await clickText('Remove')
  await page.waitForSelector('dialog[open] .image-drop')
  check('removing goes back to the empty drop zone', true)
  await clickText('Save changes')
  await waitText('Event updated')
  await settle()
  const rowAfter = await cardSelector('.manage-card', title)
  check('the thumbnail is gone from the list', rowAfter && (await page.$(`${rowAfter} .manage-thumb`)) === null, rowAfter)
  const after = await prisma.event.findFirst({ where: { title }, include: { image: true } })
  check('the row was deleted too', after?.image === null)
  await shot('organizer-after-remove')

  // ------------------------------------------------------------------ small screens
  await page.setViewport({ width: 390, height: 844 })
  await signInAs('e2e-s1')
  await sleep(400)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  check('no horizontal scroll at 390px', overflow <= 0, overflow)
  await shot('phone-discover')
} catch (err) {
  check(`run threw: ${err.message.split('\n')[0]}`, false)
} finally {
  await shot('final')
  await browser.close()
  // Only what this run created. Supply orders go first: they'd block deleting their event.
  const events = await prisma.event.findMany({ where: { title }, select: { id: true } })
  const ids = events.map((e) => e.id)
  await prisma.booking.deleteMany({ where: { eventId: { in: ids } } })
  await prisma.merchPreorder.deleteMany({ where: { eventId: { in: ids } } })
  await prisma.event.deleteMany({ where: { id: { in: ids } } })
  await prisma.venue.deleteMany({ where: { id: venue.id, events: { none: {} } } })
  await prisma.auditLog.deleteMany({ where: { actorLabel: { startsWith: 'E2E ' } } })
  fs.rmSync(posterPath, { force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
if (consoleErrors.length) console.log('console errors:', consoleErrors)
process.exit(failed.length || consoleErrors.length ? 1 : 0)
