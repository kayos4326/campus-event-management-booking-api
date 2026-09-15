// Full UI test in the Google Chrome app (visible window), against the real backend + live DB.
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const SP = new URL('.', import.meta.url).pathname
const APP = 'http://127.0.0.1:4173/events/'
const API = 'http://127.0.0.1:3998/events/api'
const SHOTS = `${SP}ui-shots`
fs.rmSync(SHOTS, { recursive: true, force: true })
fs.mkdirSync(SHOTS, { recursive: true })

const results = []
const consoleErrors = []
let section = ''
const check = (name, ok, detail) => {
  results.push({ section, name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${section}] ${name}${!ok && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`)
}
const step = async (name, fn) => {
  try { await fn() } catch (err) { check(`${name} (threw)`, false, err.message.split('\n')[0]) ; await shot(`ERROR-${name}`) }
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  slowMo: Number(process.env.SLOWMO || 12),
  userDataDir: `${SP}chrome-profile`,
  defaultViewport: { width: 1366, height: 900 },
  args: ['--window-size=1400,1020', '--no-first-run', '--no-default-browser-check'],
})
await browser.defaultBrowserContext().overridePermissions('http://127.0.0.1:4173', ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'])
const page = (await browser.pages())[0] || (await browser.newPage())
page.setDefaultTimeout(20000)
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push({ section, text: m.text() }) })
page.on('pageerror', (e) => consoleErrors.push({ section, text: `PAGE ERROR: ${e.message}` }))
page.on('dialog', async (d) => { consoleErrors.push({ section, text: `unexpected native dialog: ${d.message()}` }); await d.dismiss() })

// ---------------------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Wait for API calls to finish (map images can keep loading in the background, so this is capped).
const settle = () => page.waitForNetworkIdle({ idleTime: 250, timeout: 4000 }).catch(() => {})
let shotN = 0
const shot = async (name, fullPage = true) => {
  shotN += 1
  await page.screenshot({ path: `${SHOTS}/${String(shotN).padStart(3, '0')}-${name.replace(/[^\w-]+/g, '_')}.png`, fullPage }).catch(() => {})
}
async function signInAs(user) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.evaluate((u) => { u ? localStorage.setItem('e2eUser', u) : localStorage.removeItem('e2eUser') }, user)
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  // Wait for the app to finish its first render: sign-in page, account error, or the nav + page heading.
  await page.waitForFunction(() => {
    const t = document.body.innerText
    return t.includes('Sign in with Microsoft') || t.includes("We couldn't load your account") || (document.querySelector('nav') && document.querySelector('.page-header h1'))
  }, { timeout: 20000 })
  await settle()
}
const bodyText = () => page.evaluate(() => document.body.innerText)
const waitText = (t, timeout = 10000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, t)
const hasText = async (t, timeout = 5000) => { try { await waitText(t, timeout); return true } catch { return false } }
const waitToast = async (t) => {
  try {
    await page.waitForFunction((t) => [...document.querySelectorAll('.toast')].some((x) => x.innerText.includes(t)), { timeout: 10000 }, t)
    return true
  } catch { return false }
}
const norm = (s) => s.replace(/\s+/g, ' ').trim()

// Finds a visible button by its text, inside the top-most open dialog when one is open
// (a real modal blocks everything behind it), optionally inside a card with a given title.
async function findButton(label, { card, prefix, nav, ariaLabel } = {}) {
  const handle = await page.evaluateHandle(({ label, card, prefix, nav, ariaLabel }) => {
    const norm = (s) => s.replace(/\s+/g, ' ').trim()
    const dialogs = [...document.querySelectorAll('dialog[open]')]
    let root = dialogs.length ? dialogs[dialogs.length - 1] : document
    if (nav) root = document.querySelector('nav')
    if (card) root = [...root.querySelectorAll('article')].find((a) => norm(a.querySelector('h3')?.textContent || '') === card)
    if (!root) return null
    return [...root.querySelectorAll('button')].find((b) => {
      if (!b.getClientRects().length) return false
      if (ariaLabel) return b.getAttribute('aria-label') === ariaLabel
      const t = norm(b.textContent)
      return prefix ? t.startsWith(label) : t === label
    }) || null
  }, { label, card, prefix, nav, ariaLabel })
  const el = handle.asElement()
  if (!el) throw new Error(`button "${label || ariaLabel}"${card ? ` in "${card}"` : ''} not found`)
  return el
}
const click = async (label, opts) => { const el = await findButton(label, opts); await el.click(); await settle() }
const buttonExists = async (label, opts) => { try { await findButton(label, opts); return true } catch { return false } }

async function field(label) {
  const handle = await page.evaluateHandle((label) => {
    const dialogs = [...document.querySelectorAll('dialog[open]')]
    const root = dialogs.length ? dialogs[dialogs.length - 1] : document
    const f = [...root.querySelectorAll('.field')].find((x) => x.querySelector('.field-label')?.textContent.trim().startsWith(label))
    return f?.querySelector('input, textarea, select') || null
  }, label)
  const el = handle.asElement()
  if (!el) throw new Error(`field "${label}" not found`)
  return el
}
async function typeInto(label, value) {
  const el = await field(label)
  await el.click({ clickCount: 3 })
  await page.keyboard.down('Meta'); await page.keyboard.press('KeyA'); await page.keyboard.up('Meta')
  await page.keyboard.press('Backspace')
  await el.type(String(value), { delay: 4 })
}
async function setDateTime(label, date) {
  const el = await field(label)
  const pad = (n) => String(n).padStart(2, '0')
  const v = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  await page.evaluate((el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, el, v)
}
async function selectOption(label, textStartsWith) {
  const el = await field(label)
  const value = await page.evaluate((el, t) => [...el.options].find((o) => o.textContent.startsWith(t))?.value, el, textStartsWith)
  if (!value) throw new Error(`option "${textStartsWith}" not in "${label}"`)
  await el.select(value)
}
const openDialogs = () => page.evaluate(() => [...document.querySelectorAll('dialog[open]')].map((d) => d.querySelector('h2')?.textContent))
const cardText = (title) => page.evaluate((title) => {
  const a = [...document.querySelectorAll('article')].find((x) => x.querySelector('h3')?.textContent.replace(/\s+/g, ' ').trim() === title)
  return a ? a.innerText.replace(/\s+/g, ' ') : null
}, title)
const navLabels = () => page.evaluate(() => [...document.querySelectorAll('nav button')].map((b) => b.textContent.trim()))
const overflowPx = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
const stats = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.stat')].map((s) => [s.querySelector('.stat-label').textContent, s.querySelector('.stat-value').textContent])))
const inDays = (d, h, m = 0) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, m, 0, 0); return x }
async function apiCall(user, method, path, body, headers = {}) {
  const res = await fetch(API + path, {
    method, headers: { ...(user ? { authorization: `Bearer ${user}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const txt = await res.text(); let data; try { data = JSON.parse(txt) } catch { data = txt }
  return { status: res.status, data }
}

const WORKSHOP = '[E2E] UI Workshop'
const SOCIAL = '[E2E] UI Draft Social'
const SOCIAL_RENAMED = '[E2E] UI Social Night'

// ---------------------------------------------------------------------------- tests
section = 'sign-in'
await step('sign-in page', async () => {
  await signInAs(null)
  const t = await bodyText()
  check('sign-in page shows headline, Microsoft button and role legend', t.includes('one seat') && t.includes('Sign in with Microsoft') && t.includes('Manage people, events and API keys'))
  check('no horizontal overflow at 1366px', (await overflowPx()) <= 0)
  await shot('signin')
  await click('Sign in with Microsoft')
  check('"Sign in with Microsoft" starts the Microsoft redirect', (await page.evaluate(() => window.__e2eLoginRedirect)) === 1)
})

section = 'account error (expected 401s)'
await step('unknown account', async () => {
  await signInAs('e2e-ghost')
  check('failed /me shows a recoverable error screen', await hasText("We couldn't load your account"))
  await shot('account-error')
  await click('Try again')
  await sleep(800)
  check('"Try again" retries and stays on the error screen (still 401)', await hasText("We couldn't load your account"))
  await click('Sign out')
  check('"Sign out" returns to the sign-in page', await hasText('Sign in with Microsoft'))
  check('…and clears the session', (await page.evaluate(() => localStorage.getItem('e2eUser'))) === null)
})

section = 'organizer: create & manage'
await step('organizer tabs + empty state', async () => {
  await signInAs('e2e-org2')
  const nav = await navLabels()
  check('organizer sees Discover + My events only', JSON.stringify(nav) === JSON.stringify(['Discover', 'My events']), nav)
  await waitText('Discover events')
  check('organizer sees no booking buttons on Discover', !(await buttonExists('Reserve a seat')) && !(await buttonExists('Join waitlist')))
  check('topbar shows tidy name + role', (await bodyText()).includes('E2E Organizer Two'))
  await click('My events', { nav: true })
  check('empty state for a new organizer', await hasText('created any events yet'))
  const s = await stats()
  check('all stats start at 0', Object.values(s).every((v) => v === '0'), s)
  await shot('organizer-empty')
})

await step('create event: validation + publish', async () => {
  await click('Create your first event')
  check('"Create an event" dialog opens', JSON.stringify(await openDialogs()) === JSON.stringify(['Create an event']))
  check('title field has focus', await page.evaluate(() => document.activeElement?.placeholder?.includes('Career Fair')))
  await click('Publish event')
  check('empty form is blocked by required-field validation', !(await page.evaluate(() => document.querySelector('#event-form').checkValidity())) && (await openDialogs()).length === 1)
  await typeInto('Title', WORKSHOP)
  await typeInto('Description', 'Hands-on UI test workshop')
  await setDateTime('Starts', inDays(3, 10))
  await setDateTime('Ends', inDays(3, 9))
  await selectOption('Venue', '[E2E] Test Hall')
  await typeInto('Capacity', 1)
  await shot('create-event-filled')
  await click('Publish event')
  check('end-before-start shows an inline error', await hasText('The event has to end after it starts.'))
  check('…and the dialog stays open', (await openDialogs()).length === 1)
  await setDateTime('Ends', inDays(3, 12))
  await click('Publish event')
  check('publishing shows a success toast', await waitToast('Event published'))
  check('dialog closes after saving', (await openDialogs()).length === 0)
  const c = await cardText(WORKSHOP)
  check('new event row: Published, 0 / 1 booked, 1 seat left', c?.includes('Published') && c?.includes('0 / 1 booked') && c?.includes('1 seat left'), c)
  check('stats: 1 upcoming event', (await stats())['Upcoming events'] === '1')
})

await step('draft → publish', async () => {
  await click('New event')
  await typeInto('Title', SOCIAL)
  await setDateTime('Starts', inDays(5, 18))
  await setDateTime('Ends', inDays(5, 21))
  await selectOption('Venue', '[E2E] Test Hall')
  await typeInto('Capacity', 3)
  await click('Save as draft')
  check('submit button switches to "Save draft"', await buttonExists('Save draft'))
  await click('Save draft')
  check('draft toast', await waitToast('Draft saved'))
  const c = await cardText(SOCIAL)
  check('draft row shows Draft pill + Publish button', c?.includes('Draft') && (await buttonExists('Publish', { card: SOCIAL })), c)
  check('stats: 1 draft', (await stats()).Drafts === '1')
  await click('Drafts', { prefix: true })
  let titles = await page.evaluate(() => [...document.querySelectorAll('.manage-list article h3')].map((h) => h.textContent))
  check('Drafts filter shows only the draft', JSON.stringify(titles) === JSON.stringify([SOCIAL]), titles)
  await click('Published', { prefix: true })
  titles = await page.evaluate(() => [...document.querySelectorAll('.manage-list article h3')].map((h) => h.textContent))
  check('Published filter shows only the workshop', JSON.stringify(titles) === JSON.stringify([WORKSHOP]), titles)
  await click('All', { prefix: true })
  await click('Publish', { card: SOCIAL })
  check('Publish button publishes the draft', await waitToast('Event published'))
  check('draft is now Published', (await cardText(SOCIAL))?.includes('Published'))
  check('stats: 0 drafts, 2 upcoming', (await stats()).Drafts === '0' && (await stats())['Upcoming events'] === '2')
  await shot('organizer-two-events')
})

await step('edit event', async () => {
  await click('Edit', { card: SOCIAL })
  check('"Edit event" dialog opens', (await openDialogs())[0] === 'Edit event')
  check('edit form is prefilled', (await page.evaluate(async () => document.querySelector('dialog[open] input').value)) === SOCIAL)
  check('venue is read-only when editing', await page.evaluate(() => document.querySelector('#event-venue').disabled))
  await typeInto('Title', SOCIAL_RENAMED)
  await typeInto('Capacity', 4)
  await click('Save changes')
  check('update toast', await waitToast('Event updated'))
  const c = await cardText(SOCIAL_RENAMED)
  check('row shows new title and capacity 0 / 4', c?.includes('0 / 4 booked'), c)
})

await step('dialogs: Escape, backdrop, stacking', async () => {
  await click('Edit', { card: SOCIAL_RENAMED })
  await page.keyboard.press('Escape'); await sleep(200)
  check('Escape closes a dialog', (await openDialogs()).length === 0)
  await click('New event')
  await page.mouse.click(8, 450); await sleep(200)
  check('clicking the backdrop closes a dialog', (await openDialogs()).length === 0)
  await click('New event')
  await click('Add a venue')
  check('"Add a venue" opens on top of the event form', JSON.stringify(await openDialogs()) === JSON.stringify(['Create an event', 'Add a venue']))
  await shot('stacked-dialogs', false)
  await click('Cancel')
  check('closing the venue dialog returns to the event form', JSON.stringify(await openDialogs()) === JSON.stringify(['Create an event']))
  await click('Add a venue')
  await typeInto('Venue name', '[E2E] UI Venue')
  await typeInto('Room number', 'E2E-UI1')
  await typeInto('Address', 'Assumption University Suvarnabhumi Campus, Samut Prakan')
  await click('Add venue')
  check('venue added toast', await waitToast('Venue added'))
  check('back on the event form after adding the venue', JSON.stringify(await openDialogs()) === JSON.stringify(['Create an event']))
  const selected = await page.evaluate(() => { const s = document.querySelector('#event-venue'); return s.options[s.selectedIndex]?.textContent })
  check('the new venue is auto-selected in the event form', selected?.startsWith('[E2E] UI Venue'), selected)
  await click('Cancel')
  check('Cancel closes the event form', (await openDialogs()).length === 0)
  check('new venue card appears in the gallery', await page.evaluate(() => [...document.querySelectorAll('.venue-card strong')].some((s) => s.textContent.includes('[E2E] UI Venue'))))
  check('new venue card shows a real map image', await page.evaluate(() => {
    const card = [...document.querySelectorAll('.venue-card')].find((c) => c.innerText.includes('[E2E] UI Venue'))
    const img = card?.querySelector('img')
    return !!img && img.src.startsWith('https://maps.geoapify.com') && img.complete && img.naturalWidth > 0
  }))
})

await step('add venue', async () => {
  await click('Add venue')
  await typeInto('Venue name', '[E2E] UI Bad Venue')
  await typeInto('Address', 'qwxzv plorkt znnnq 99999 asdfgh')
  await click('Add venue')
  check('bad address shows the API error inside the dialog', await hasText('Address does not resolve to a real place'))
  await shot('venue-bad-address', false)
  await click('Cancel')
  check('Cancel closes the venue dialog without saving', (await openDialogs()).length === 0)
})

section = 'student: book, waitlist, cancel, promotion'
await step('s1 reserves the only seat', async () => {
  await signInAs('e2e-s1')
  const nav = await navLabels()
  check('student sees Discover + My bookings only', JSON.stringify(nav) === JSON.stringify(['Discover', 'My bookings']), nav)
  const search = await page.$('input[type=search]')
  await search.type('UI Workshop', { delay: 10 })
  const titles = await page.evaluate(() => [...document.querySelectorAll('.event-card h3')].map((h) => h.textContent))
  check('search narrows the list to the workshop', JSON.stringify(titles) === JSON.stringify([WORKSHOP]), titles)
  let c = await cardText(WORKSHOP)
  check('card shows venue, time, 0 / 1 booked', c?.includes('[E2E] Test Hall') && c?.includes('0 / 1 booked') && c?.includes('Reserve a seat'), c)
  await shot('student-discover')
  await click('Reserve a seat', { card: WORKSHOP })
  check('"Seat reserved" toast', await waitToast('Seat reserved'))
  c = await cardText(WORKSHOP)
  check('card now says "You\'re going" and shows Full', c?.includes("You're going") && c?.includes('Full'), c)
  check('"View my bookings" shortcut appears', await buttonExists('View my bookings'))
  await search.click({ clickCount: 3 }); await page.keyboard.press('Backspace')
  await search.type('zzz no such event', { delay: 5 })
  check('no-match search shows an empty state', await hasText('No events match your search'))
  await search.click({ clickCount: 3 }); await page.keyboard.press('Backspace')
  await click('All events')
  check('"All events" filter toggles on', await page.evaluate(() => [...document.querySelectorAll('.segmented button')].find((b) => b.textContent === 'All events').getAttribute('aria-pressed') === 'true'))
  await click('Upcoming')
})

await step('s2 joins the waitlist', async () => {
  await signInAs('e2e-s2')
  await (await page.$('input[type=search]')).type('UI Workshop', { delay: 5 })
  let c = await cardText(WORKSHOP)
  check('full event offers "Join waitlist" and shows Full', c?.includes('Join waitlist') && c?.includes('Full'), c)
  await click('Join waitlist', { card: WORKSHOP })
  check('waitlist toast explains what happens next', await waitToast("You're on the waitlist"))
  c = await cardText(WORKSHOP)
  check('card now says "You\'re on the waitlist", 1 waiting', c?.includes("You're on the waitlist") && c?.includes('1 waiting'), c)
  await click('My bookings', { nav: true })
  c = await cardText(WORKSHOP)
  check('ticket shows Waitlisted + auto-promotion hint', c?.includes('Waitlisted') && c?.includes("You'll be moved up automatically"), c)
  await shot('student-waitlisted-ticket')
})

await step('s1 cancels → s2 promoted', async () => {
  await signInAs('e2e-s1')
  await click('My bookings', { nav: true })
  check('ticket shows Confirmed', (await cardText(WORKSHOP))?.includes('Confirmed'))
  await click('Cancel booking', { card: WORKSHOP })
  check('confirm dialog explains the seat goes to the waitlist', (await openDialogs())[0] === 'Cancel this booking?' && await hasText('next person on the waitlist'))
  await shot('cancel-booking-confirm', false)
  await click('Keep it')
  check('"Keep it" closes without cancelling', (await openDialogs()).length === 0 && (await cardText(WORKSHOP))?.includes('Confirmed'))
  await click('Cancel booking', { card: WORKSHOP })
  await click('Cancel booking')
  check('"Booking cancelled" toast', await waitToast('Booking cancelled'))
  check('ticket leaves the Upcoming tab', (await cardText(WORKSHOP)) === null)
  await click('Cancelled', { prefix: true })
  const c = await cardText(WORKSHOP)
  check('Cancelled tab shows it with "Book again"', c?.includes('Cancelled') && c?.includes('Book again'), c)

  await signInAs('e2e-s2')
  await click('My bookings', { nav: true })
  check('s2 was automatically promoted to Confirmed', (await cardText(WORKSHOP))?.includes('Confirmed'))
})

await step('s1 books again → back of the waitlist', async () => {
  await signInAs('e2e-s1')
  await click('My bookings', { nav: true })
  await click('Cancelled', { prefix: true })
  await click('Book again', { card: WORKSHOP })
  check('rebooking a full event → waitlist toast', await waitToast("You're on the waitlist"))
  check('view jumps back to Upcoming', await page.evaluate(() => [...document.querySelectorAll('.segmented button')].find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent.startsWith('Upcoming')))
  check('ticket shows Waitlisted again', (await cardText(WORKSHOP))?.includes('Waitlisted'))
  await shot('student-bookings')
})

section = 'organizer: attendees, capacity, cancel'
await step('attendees + capacity + cancel event', async () => {
  const mine = await apiCall('e2e-org2', 'GET', '/events?mine=true')
  const social = mine.data.find((e) => e.title === SOCIAL_RENAMED)
  for (const s of ['e2e-s3', 'e2e-s4', 'e2e-s5']) await apiCall(s, 'POST', '/bookings', { eventId: social.id })

  await signInAs('e2e-org2')
  await click('My events', { nav: true })
  let c = await cardText(WORKSHOP)
  check('workshop row: 1 / 1 booked, Full · 1 waiting', c?.includes('1 / 1 booked') && c?.includes('1 waiting'), c)
  check('stats: seats booked 4, on waitlists 1', (await stats())['Seats booked'] === '4' && (await stats())['On waitlists'] === '1', await stats())
  await click('Attendees', { card: WORKSHOP })
  check('attendees dialog summary: 1 confirmed · 1 waitlisted', await hasText('1 confirmed · 1 waitlisted'))
  const rows = await page.evaluate(() => [...document.querySelectorAll('dialog[open] tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ')))
  check('confirmed first (Student 2), then waitlisted (Student 1)', rows.length === 2 && rows[0].includes('E2E Student 2') && rows[0].includes('Confirmed') && rows[1].includes('E2E Student 1') && rows[1].includes('Waitlisted'), rows)
  await shot('attendees', false)
  await click('', { ariaLabel: 'Close' })
  check('X button closes the dialog', (await openDialogs()).length === 0)

  await click('Edit', { card: SOCIAL_RENAMED })
  await typeInto('Capacity', 2)
  await click('Save changes')
  check('lowering capacity below 3 confirmed shows the API reason in the dialog', await hasText("Capacity can't be lower than the 3 seats already confirmed"))
  await shot('capacity-error', false)
  await click('Cancel')

  await click('Cancel', { card: WORKSHOP })
  check('cancel-event dialog states the booking counts', (await openDialogs())[0] === 'Cancel this event?' && await hasText('all 1 confirmed and 1 waitlisted bookings'))
  await click('Cancel event')
  check('"Event cancelled" toast', await waitToast('Event cancelled'))
  c = await cardText(WORKSHOP)
  check('row shows Cancelled with only Attendees left', c?.includes('Cancelled') && !(await buttonExists('Edit', { card: WORKSHOP })) && !(await buttonExists('Cancel', { card: WORKSHOP })) && (await buttonExists('Attendees', { card: WORKSHOP })), c)
  check('Cancelled filter count is 1', await page.evaluate(() => [...document.querySelectorAll('.segmented button')].find((b) => b.textContent.startsWith('Cancelled'))?.textContent === 'Cancelled1'))

  await signInAs('e2e-s2')
  await click('My bookings', { nav: true })
  await click('Cancelled', { prefix: true })
  c = await cardText(WORKSHOP)
  check('student sees "The organizer cancelled this event." and no Book again', c?.includes('The organizer cancelled this event.') && !c.includes('Book again'), c)
  await click('Discover', { nav: true })
  await (await page.$('input[type=search]')).type('UI Workshop', { delay: 5 })
  check('cancelled event is gone from Discover', await hasText('No events match your search'))
})

section = 'admin'
await step('admin panel', async () => {
  await signInAs('e2e-admin')
  const nav = await navLabels()
  check('admin sees Discover + My events + Admin', JSON.stringify(nav) === JSON.stringify(['Discover', 'My events', 'Admin']), nav)
  await click('My events', { nav: true })
  check('admin can use My events (empty state)', await hasText('created any events yet'))
  await click('Admin', { nav: true })
  await waitText('People signed in')
  const s = await stats()
  check('admin stats are numbers > 0', Object.values(s).length === 4 && Object.values(s).every((v) => Number(v) > 0), s)
  const ownRow = await page.evaluate(() => [...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes('e2e-admin@e2e.invalid'))?.innerText)
  check('own row says "That\'s you" with no role control', ownRow?.includes("That's you") && !(await page.evaluate(() => [...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes('e2e-admin@e2e.invalid'))?.querySelector('select'))), ownRow)
  await shot('admin-people')

  const roleSelect = async () => (await page.evaluateHandle(() => [...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes('e2e-rolechange@e2e.invalid'))?.querySelector('select'))).asElement()
  const roleText = () => page.evaluate(() => [...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes('e2e-rolechange@e2e.invalid'))?.querySelector('.pill')?.textContent)
  await (await roleSelect()).select('ORGANIZER')
  check('choosing a role opens a confirmation', (await openDialogs())[0] === 'Change role?' && await hasText('from Student to Organizer'))
  await click('Keep it')
  check('"Keep it" leaves the role unchanged', (await roleText()) === 'Student')
  await (await roleSelect()).select('ORGANIZER')
  await click('Change role')
  check('"Role updated" toast', await waitToast('Role updated'))
  check('role pill updates to Organizer', await page.waitForFunction(() => [...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes('e2e-rolechange@e2e.invalid'))?.querySelector('.pill')?.textContent === 'Organizer').then(() => true).catch(() => false))
  check('the role really changed server-side', (await apiCall('e2e-rolechange', 'GET', '/me')).data.role === 'ORGANIZER')
  await (await roleSelect()).select('STUDENT')
  await click('Change role')
  await waitToast('Role updated')
  check('role reverted to Student', (await apiCall('e2e-rolechange', 'GET', '/me')).data.role === 'STUDENT')

  await click('Events', { prefix: true })
  const evRow = await page.evaluate((t) => [...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes(t))?.innerText.replace(/\s+/g, ' '), SOCIAL_RENAMED)
  check('Events tab: row with organizer, status and 3/4 seats', evRow?.includes('E2E Organizer Two') && evRow?.includes('Published') && evRow?.includes('3/4'), evRow)
  await click('Bookings', { prefix: true })
  check('Bookings tab lists student bookings', await page.evaluate(() => document.querySelectorAll('tbody tr').length > 0 && document.body.innerText.includes('E2E Student')))
  await shot('admin-bookings')

  await click('API keys')
  await click('Issue key')
  check('issuing without a label is blocked by validation', !(await page.evaluate(() => document.querySelector('form.stack-sm').checkValidity())))
  await (await page.$('input[placeholder="e.g. Library display screen"]')).type('[E2E] UI key', { delay: 5 })
  await click('Issue key')
  await page.waitForSelector('.key-row code')
  const key = await page.$eval('.key-row code', (c) => c.textContent)
  check('key is revealed once (64 hex chars) with a warning', /^[0-9a-f]{64}$/.test(key) && await hasText("won't be shown again"))
  await click('Copy')
  check('Copy button confirms "Copied"', await buttonExists('Copied'))
  check('clipboard really holds the key', (await page.evaluate(() => navigator.clipboard.readText())) === key)
  check('issued key works on the room-status API', (await apiCall(null, 'GET', '/peer/events/active?room=E2E-901', undefined, { 'x-api-key': key })).status === 200)
  await shot('admin-api-key')
  const keyRow = () => page.evaluate(() => [...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes('[E2E] UI key'))?.innerText.replace(/\s+/g, ' '))
  check('"All keys" table lists the new key as Active', (await keyRow())?.includes('Active'), await keyRow())
  check('the raw key is not shown in the table', !(await keyRow())?.includes(key))
  const revokeBtn = (await page.evaluateHandle(() => [...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes('[E2E] UI key'))?.querySelector('button'))).asElement()
  await revokeBtn.click()
  check('revoking asks for confirmation', (await openDialogs())[0] === 'Revoke this key?' && await hasText('immediately get 401 errors'))
  await click('Keep it')
  check('"Keep it" leaves the key active', (await keyRow())?.includes('Active'))
  await revokeBtn.click()
  await click('Revoke key')
  check('"Key revoked" toast', await waitToast('Key revoked'))
  check('status shows Revoked and the one-time key is hidden', (await keyRow())?.includes('Revoked') && !(await page.$('.key-row code')))
  check('revoked key is rejected by the API (401)', (await apiCall(null, 'GET', '/peer/events/active?room=E2E-901', undefined, { 'x-api-key': key })).status === 401)

  check('the Admin tab is reflected in the URL', page.url().endsWith('#admin'), page.url())
  await page.reload({ waitUntil: 'domcontentloaded' })
  check('reloading keeps you on the Admin tab', await hasText('People signed in', 15000))
  await click('API keys')
  await page.waitForFunction(() => document.body.innerText.includes('All keys') && document.querySelectorAll('tbody tr').length > 0)
  check('after a reload the key list still shows the revoked key (loaded from the server)', (await keyRow())?.includes('Revoked'), await keyRow())
  await shot('admin-api-keys-list')

  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {})
  check('browser Back returns to the previous tab (My events)', page.url().endsWith('#organizer') && await hasText('created any events yet', 10000), page.url())
  await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {})
  check('browser Forward returns to Admin', page.url().endsWith('#admin') && await hasText('People signed in', 10000), page.url())

  await click('', { ariaLabel: 'Sign out' })
  check('topbar sign-out returns to the sign-in page', await hasText('Sign in with Microsoft'))
})

section = 'responsive'
const pages = [
  ['signed-out', null, null],
  ['student-discover', 'e2e-s1', null],
  ['student-bookings', 'e2e-s1', 'My bookings'],
  ['organizer-events', 'e2e-org2', 'My events'],
  ['admin-people', 'e2e-admin', 'Admin'],
]
for (const [w, h] of [[390, 844], [768, 1024]]) {
  await page.setViewport({ width: w, height: h })
  for (const [name, user, tab] of pages) {
    await step(`${name} @${w}`, async () => {
      await signInAs(user)
      if (tab) await click(tab, { nav: true })
      await sleep(300)
      const over = await overflowPx()
      check(`${name} at ${w}px has no horizontal scroll`, over <= 0, `${over}px too wide`)
      await shot(`${name}-${w}`)
    })
  }
  await step(`dialog @${w}`, async () => {
    await signInAs('e2e-org2')
    await click('My events', { nav: true })
    await click('New event')
    const rect = await page.evaluate(() => { const r = document.querySelector('dialog[open]').getBoundingClientRect(); return { left: r.left, right: r.right } })
    check(`event dialog fits inside ${w}px`, rect.left >= 0 && rect.right <= w, rect)
    await shot(`dialog-${w}`, false)
    await page.keyboard.press('Escape')
  })
}

section = 'dark mode'
await page.setViewport({ width: 1366, height: 900 })
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
for (const [name, user, tab] of pages) {
  await step(`dark ${name}`, async () => {
    await signInAs(user)
    if (tab) await click(tab, { nav: true })
    await sleep(300)
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    check(`${name}: dark background applied`, bg === 'rgb(16, 16, 19)', bg)
    await shot(`dark-${name}`)
  })
}
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])

section = 'console'
// Chrome logs every 4xx response as a console error. The 4xx responses here come from
// deliberate negative tests (unknown account, bad address, capacity too low), which the
// checks above already verify the UI handles — anything else (JS errors, 5xx) is a failure.
const isExpected4xx = (e) => /Failed to load resource: the server responded with a status of 4\d\d/.test(e.text)
consoleErrors.filter(isExpected4xx).forEach((e) => console.log(`  expected: [${e.section}] ${e.text}`))
const unexpected = consoleErrors.filter((e) => !isExpected4xx(e))
check('no unexpected console errors or page errors anywhere', unexpected.length === 0, unexpected.slice(0, 10))
const expected = consoleErrors.filter((e) => e.section.includes('expected 401'))
console.log(`  (${expected.length} expected 401 console messages in the unknown-account test)`)

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed · ${shotN} screenshots in ${SHOTS}`)
if (failed.length) { console.log('FAILED:'); failed.forEach((f) => console.log(`  [${f.section}] ${f.name}`)) }
