// The supply-order outbox against real MySQL, real app processes and a fake Discord that
// can fail on command — so nothing is posted to the team's real channel. Run it against a
// throwaway database (README.md, "Running it all locally"): it adds and removes MySQL
// triggers to force failures.
//
//   MYSQL="docker exec -i campus-mysql mysql -uroot -proot campus_events" \
//   DATABASE_URL=… APP_DIR=$PWD node tests/e2e/outbox-test.mjs
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const APP_DIR = process.env.APP_DIR
const MYSQL = (process.env.MYSQL || '').split(' ').filter(Boolean)
if (!APP_DIR || !process.env.DATABASE_URL || MYSQL.length === 0) {
  console.error('Set APP_DIR, DATABASE_URL and MYSQL (a mysql client command for the test database).')
  process.exit(2)
}
if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto
const { prisma } = require(`${APP_DIR}/src/services/prisma`)

let passed = 0
const failures = []
let section = ''
const check = (name, ok, detail) => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failures.push(`[${section}] ${name}`); console.log(`  ✗ ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`) }
}
const heading = (name) => { section = name; console.log(`\n${name}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeoutMs = 8000, everyMs = 100) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    last = await fn()
    if (last) return last
    await sleep(everyMs)
  }
  return last
}
// Fed through stdin with a custom delimiter, so trigger bodies can contain semicolons.
const sql = (statements) =>
  execFileSync(MYSQL[0], MYSQL.slice(1), { input: `DELIMITER //\n${statements.split(/;\s*(?=DROP|CREATE)/).join('//\n')}//\n`, stdio: ['pipe', 'pipe', 'pipe'] })

// ------------------------------------------------------------------------ fake Discord

const discord = {
  outage: false, // every request → 503
  refuse: new Set(), // titles answered 404
  hanging: [], // requests left unanswered, as if the process died mid-call
  log: [], // { title, at, status }
  nextId: 1549433934344000000n,
}
const scripted = new Map() // title → list of statuses to answer with, in order, before 200s

const fake = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', async () => {
    const content = JSON.parse(body || '{}').content || ''
    const title = (content.match(/for "(.+?)" \(event/) || [])[1] || '?'
    const answer = (status, data) => {
      discord.log.push({ title, at: Date.now(), status })
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    if (!req.url.includes('wait=true')) return answer(400, { message: 'expected ?wait=true' })
    if (title.includes('[slow]')) await sleep(150)
    if (discord.outage) return answer(503, { message: 'down' })
    if (discord.refuse.has(title)) return answer(404, { message: 'Unknown Webhook' })
    const queue = scripted.get(title)
    if (queue?.length) {
      const next = queue.shift()
      if (next === 'hang') { discord.log.push({ title, at: Date.now(), status: 'hang' }); discord.hanging.push(res); return }
      if (next === 429) return answer(429, { message: 'rate limited', retry_after: 0.6 })
      return answer(next, { message: 'scripted failure' })
    }
    discord.nextId += 1n
    return answer(200, { id: String(discord.nextId), content })
  })
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const WEBHOOK = `http://127.0.0.1:${fake.address().port}/api/webhooks/1/test-token`
const successes = (title) => discord.log.filter((e) => e.title === title && e.status === 200)
const requestsFor = (title) => discord.log.filter((e) => e.title === title)

// --------------------------------------------------------------------------- app servers

const servers = new Map()
function startServer(port, { entry = 'tests/e2e/server.cjs', env = {} } = {}) {
  const child = spawn(process.execPath, [`${APP_DIR}/${entry}`], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      APP_DIR,
      PORT: String(port),
      DISCORD_WEBHOOK_URL: WEBHOOK,
      GEOAPIFY_API_KEY: 'not-used',
      TENANT_ID: 'not-used',
      CLIENT_ID: 'not-used',
      RATE_LIMIT_WRITES: '100000',
      RATE_LIMIT_REQUESTS: '100000',
      OUTBOX_POLL_MS: '200',
      OUTBOX_BASE_DELAY_MS: '300',
      OUTBOX_MAX_DELAY_MS: '1500',
      OUTBOX_LEASE_MS: '2500',
      OUTBOX_MAX_ATTEMPTS: '4',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.output = ''
  child.stdout.on('data', (d) => { child.output += d })
  child.stderr.on('data', (d) => { child.output += d })
  servers.set(port, child)
  return waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok } catch { return false }
  }, 20000)
}
function killServer(port, signal = 'SIGKILL') {
  const child = servers.get(port)
  servers.delete(port)
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve(null)
    const started = Date.now()
    child.once('exit', (code) => resolve({ code, ms: Date.now() - started }))
    child.kill(signal)
  })
}

const API = (port) => `http://127.0.0.1:${port}/events/api`
async function api(port, method, path, body) {
  const res = await fetch(`${API(port)}${path}`, {
    method,
    headers: { authorization: 'Bearer e2e-org', ...(body && { 'content-type': 'application/json' }) },
    body: body && JSON.stringify(body),
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}

// ---------------------------------------------------------------------------- helpers

const venue = await prisma.venue.create({
  data: { name: '[E2E] Outbox Hall', addressRaw: 'Campus', latitude: 13.61, longitude: 100.83, isVerified: true },
})
const future = (days, hours = 10) => new Date(Date.now() + days * 864e5 + hours * 36e5).toISOString()
let n = 0
async function createEvent(port, { title, status = 'PUBLISHED', item = 'Blank lanyards', quantity = 20 } = {}) {
  n += 1
  const res = await api(port, 'POST', '/events', {
    title: title ?? `[E2E] Outbox ${n}`, capacity: 30, venueId: venue.id, status,
    startsAt: future(30 + n), endsAt: future(30 + n, 12),
    ...(item && { supply: { item, quantity } }),
  })
  return res
}
const orderFor = (eventId) => prisma.merchPreorder.findUnique({ where: { eventId } })
const jobsFor = async (eventId) => {
  const order = await orderFor(eventId)
  return order ? prisma.outboxJob.findMany({ where: { dedupeKey: `supply:${order.id}` }, orderBy: { id: 'asc' } }) : []
}
const confirmed = (eventId) => waitFor(async () => (await orderFor(eventId))?.status === 'CONFIRMED')

const A = 3998
const B = 3997

try {
  await startServer(A)

  // ------------------------------------------------------------------------ atomicity
  heading('The event, its supply order and the job commit together or not at all')
  sql(`DROP TRIGGER IF EXISTS e2e_fail_order;
    CREATE TRIGGER e2e_fail_order BEFORE INSERT ON merch_preorders FOR EACH ROW
    BEGIN IF NEW.item = 'E2E fail order' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced by e2e'; END IF; END`)
  sql(`DROP TRIGGER IF EXISTS e2e_fail_job;
    CREATE TRIGGER e2e_fail_job BEFORE INSERT ON outbox_jobs FOR EACH ROW
    BEGIN IF (SELECT item FROM merch_preorders WHERE id = JSON_EXTRACT(NEW.payload, '$.preorderId')) = 'E2E fail job'
    THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced by e2e'; END IF; END`)

  let res = await createEvent(A, { title: '[E2E] Atomic order', item: 'E2E fail order' })
  check('the supply order insert fails → the request fails', res.status === 500, res)
  check('…and no event was left behind', (await prisma.event.count({ where: { title: '[E2E] Atomic order' } })) === 0)

  res = await createEvent(A, { title: '[E2E] Atomic job', item: 'E2E fail job' })
  check('queuing the delivery fails → the request fails', res.status === 500, res)
  check('…and neither the event nor its order exists', (await prisma.event.count({ where: { title: '[E2E] Atomic job' } })) === 0 &&
    (await prisma.merchPreorder.count({ where: { item: 'E2E fail job' } })) === 0)

  const draft = (await createEvent(A, { title: '[E2E] Atomic publish', status: 'DRAFT', item: 'E2E fail job' })).data
  check('a draft with that order saves (nothing is queued for drafts)', draft?.status === 'DRAFT', draft)
  res = await api(A, 'PATCH', `/events/${draft.id}`, { status: 'PUBLISHED' })
  const afterFailedPublish = await prisma.event.findUnique({ where: { id: draft.id } })
  check('publishing fails when its job can\'t be queued', res.status === 500, res)
  check('…so the event is still a draft, with no job', afterFailedPublish.status === 'DRAFT' && (await jobsFor(draft.id)).length === 0, afterFailedPublish.status)
  sql('DROP TRIGGER e2e_fail_order; DROP TRIGGER e2e_fail_job')
  check('nothing reached Discord from any of it', discord.log.length === 0, discord.log)

  // ------------------------------------------------------------------------ delivery
  heading('Delivery')
  let event = (await createEvent(A, { title: '[E2E] Plain delivery' })).data
  check('publishing with supplies returns straight away', event?.status === 'PUBLISHED', event)
  check('the order is confirmed shortly after', await confirmed(event.id))
  let [job] = await jobsFor(event.id)
  let order = await orderFor(event.id)
  check('the Discord message id is stored', successes('[E2E] Plain delivery')[0] && order.peerOrderRef === String(discord.nextId), order)
  check('the job is DONE after one attempt, with a note', job?.status === 'DONE' && job.attempts === 1 && /^sent/.test(job.note), job)
  check('exactly one message was posted', requestsFor('[E2E] Plain delivery').length === 1)

  const drafted = (await createEvent(A, { title: '[E2E] Draft first', status: 'DRAFT' })).data
  await sleep(700)
  check('a draft queues nothing and posts nothing', (await jobsFor(drafted.id)).length === 0 && requestsFor('[E2E] Draft first').length === 0)
  await api(A, 'PATCH', `/events/${drafted.id}`, { status: 'PUBLISHED' })
  check('publishing it delivers the order', await confirmed(drafted.id))
  await api(A, 'PATCH', `/events/${drafted.id}`, { status: 'DRAFT' })
  await api(A, 'PATCH', `/events/${drafted.id}`, { status: 'PUBLISHED' })
  await sleep(800)
  check('unpublishing and publishing again doesn\'t order twice', successes('[E2E] Draft first').length === 1 && (await jobsFor(drafted.id)).length === 1)

  // ------------------------------------------------------------------------ retries
  heading('Retries')
  scripted.set('[E2E] Flaky', [500, 502])
  event = (await createEvent(A, { title: '[E2E] Flaky' })).data
  check('two server errors, then success → confirmed', await confirmed(event.id))
  ;[job] = await jobsFor(event.id)
  const flaky = requestsFor('[E2E] Flaky')
  check('it took exactly three requests and one message', flaky.length === 3 && successes('[E2E] Flaky').length === 1, flaky.map((e) => e.status))
  check('the job records three attempts and no leftover error', job.status === 'DONE' && job.attempts === 3 && job.lastError === null, job)
  check('the second wait was longer than the first (backoff)', flaky[2].at - flaky[1].at > (flaky[1].at - flaky[0].at) * 1.2,
    [flaky[1].at - flaky[0].at, flaky[2].at - flaky[1].at])

  scripted.set('[E2E] Rate limited', [429])
  event = (await createEvent(A, { title: '[E2E] Rate limited' })).data
  check('a 429 is retried and delivered', await confirmed(event.id))
  const limited = requestsFor('[E2E] Rate limited')
  check('…no sooner than Discord\'s retry_after (0.6s)', limited.length === 2 && limited[1].at - limited[0].at >= 600, limited.map((e) => e.at - limited[0].at))

  discord.refuse.add('[E2E] Refused')
  event = (await createEvent(A, { title: '[E2E] Refused' })).data
  check('a 404 (webhook gone) gives up at once: order FAILED', await waitFor(async () => (await orderFor(event.id))?.status === 'FAILED'))
  ;[job] = await jobsFor(event.id)
  check('…the job is DEAD after one attempt, with the reason', job.status === 'DEAD' && job.attempts === 1 && /404/.test(job.lastError), job)
  check('…and the error doesn\'t leak the webhook token', !String(job.lastError).includes('test-token'))
  discord.refuse.delete('[E2E] Refused')
  await api(A, 'PATCH', `/events/${event.id}`, { status: 'DRAFT' })
  await api(A, 'PATCH', `/events/${event.id}`, { status: 'PUBLISHED' })
  check('publishing again queues a fresh attempt that goes through', await confirmed(event.id))
  check('…with a new job, and one message in total', (await jobsFor(event.id)).length === 2 && successes('[E2E] Refused').length === 1)

  discord.outage = true
  event = (await createEvent(A, { title: '[E2E] Never recovers' })).data
  check('a Discord outage that outlasts every attempt ends FAILED', await waitFor(async () => (await orderFor(event.id))?.status === 'FAILED', 12000))
  ;[job] = await jobsFor(event.id)
  check('…after exactly OUTBOX_MAX_ATTEMPTS (4) tries', job.status === 'DEAD' && job.attempts === 4 && requestsFor('[E2E] Never recovers').length === 4, job)

  // Still in an outage: the job is waiting for a retry when the event is unpublished.
  event = (await createEvent(A, { title: '[E2E] Unpublished while waiting' })).data
  await waitFor(async () => (await jobsFor(event.id))[0]?.attempts >= 1)
  await api(A, 'PATCH', `/events/${event.id}`, { status: 'DRAFT' })
  await api(A, 'PATCH', `/events/${event.id}`, { status: 'PUBLISHED' })
  check('publishing again while a retry is pending reuses that job', (await jobsFor(event.id)).length === 1)
  await api(A, 'PATCH', `/events/${event.id}`, { status: 'DRAFT' })
  discord.outage = false
  check('the retry of an unpublished event is skipped, not sent', await waitFor(async () => /skipped/.test((await jobsFor(event.id))[0]?.note || '')))
  check('…and the order is still PENDING', (await orderFor(event.id)).status === 'PENDING' && successes('[E2E] Unpublished while waiting').length === 0)
  await api(A, 'PATCH', `/events/${event.id}`, { status: 'PUBLISHED' })
  check('publishing it later delivers it once', await confirmed(event.id) && successes('[E2E] Unpublished while waiting').length === 1)

  // ------------------------------------------------------------------------ durability
  heading('Surviving restarts and crashes')
  discord.outage = true
  event = (await createEvent(A, { title: '[E2E] Survives restart' })).data
  await waitFor(async () => (await jobsFor(event.id))[0]?.attempts >= 1)
  await killServer(A)
  discord.outage = false
  await sleep(500)
  check('with the only worker dead, nothing is delivered', successes('[E2E] Survives restart').length === 0)
  check('…but the job is still in the database', (await jobsFor(event.id))[0]?.status === 'PENDING')
  await startServer(A)
  check('a new process picks it up and delivers it', await confirmed(event.id))

  scripted.set('[E2E] Crash mid-call', ['hang'])
  event = (await createEvent(A, { title: '[E2E] Crash mid-call' })).data
  await waitFor(() => requestsFor('[E2E] Crash mid-call').length === 1)
  await killServer(A)
  discord.hanging.splice(0).forEach((r) => r.destroy())
  const crashedJob = (await jobsFor(event.id))[0]
  check('killed mid-request: the job is left claimed', crashedJob.status === 'PROCESSING', crashedJob.status)
  await startServer(A)
  await sleep(1200)
  check('…and isn\'t retried while its lease (2.5s) is still valid', requestsFor('[E2E] Crash mid-call').length === 1)
  check('once the lease runs out it is taken over and delivered', await confirmed(event.id))
  check('…on the second attempt, with one message', (await jobsFor(event.id))[0].attempts === 2 && successes('[E2E] Crash mid-call').length === 1)

  // ------------------------------------------------------------------------ concurrency
  heading('Two worker processes')
  await startServer(B)
  discord.outage = true
  const burst = []
  for (let i = 0; i < 24; i += 1) burst.push((await createEvent(A, { title: `[E2E] Burst ${i} [slow]` })).data)
  await sleep(400)
  discord.outage = false
  const allDone = await waitFor(async () => {
    const orders = await prisma.merchPreorder.findMany({ where: { eventId: { in: burst.map((e) => e.id) } } })
    return orders.every((o) => o.status === 'CONFIRMED')
  }, 20000)
  check('24 orders queued during an outage are all delivered once it ends', allDone)
  const perTitle = burst.map((e) => successes(e.title).length)
  check('each was posted exactly once — never by both workers', perTitle.every((count) => count === 1), perTitle)

  // ------------------------------------------------------------------------ claims
  // The burst above proves delivery with two processes running, but their polls rarely
  // line up, so it can pass even without the row lock. This forces the collision: eight
  // claims at the same instant, each on its own pooled connection, over the same due jobs.
  heading('Simultaneous claims')
  await killServer(A)
  await killServer(B)
  const outbox = require(`${APP_DIR}/src/services/outbox`)
  const JOBS = 40
  await prisma.outboxJob.createMany({ data: Array.from({ length: JOBS }, (_, i) => ({ type: 'e2e.claim', payload: { i }, dedupeKey: `e2e-claim:${i}` })) })
  const claimedIds = []
  let rounds = 0
  while (rounds < 20) {
    rounds += 1
    const batches = await Promise.all(Array.from({ length: 8 }, () => outbox.claim(5)))
    const ids = batches.flat().filter((job) => job.type === 'e2e.claim').map((job) => job.id)
    if (ids.length === 0) break
    claimedIds.push(...ids)
  }
  const unique = new Set(claimedIds)
  check(`${JOBS} jobs, 8 claimers at once: every job claimed`, unique.size === JOBS, unique.size)
  check('…and no job handed to two claimers', claimedIds.length === unique.size, claimedIds.length - unique.size)
  await prisma.outboxJob.deleteMany({ where: { type: 'e2e.claim' } })

  // ------------------------------------------------------------------------ production entrypoint
  heading('src/server.js (what PM2 runs)')
  discord.outage = true
  // The API can't be reached without a real Entra token here, so queue straight into the DB.
  const direct = await prisma.event.create({
    data: {
      title: '[E2E] Via server.js', capacity: 5, venueId: venue.id, status: 'PUBLISHED',
      organizerId: (await prisma.user.findUnique({ where: { adObjectId: 'e2e-org' } })).id,
      startsAt: future(90), endsAt: future(90, 12), isLargeConference: true,
      preorder: { create: { item: 'Lanyards', quantity: 5 } },
    },
    include: { preorder: true },
  })
  await prisma.outboxJob.create({ data: { type: 'supply.send', payload: { preorderId: direct.preorder.id }, dedupeKey: `supply:${direct.preorder.id}` } })
  discord.outage = false
  await startServer(A, { entry: 'src/server.js' })
  check('the real server starts its worker and delivers', await confirmed(direct.id))
  const exit = await killServer(A, 'SIGINT')
  check('SIGINT shuts it down cleanly, inside PM2\'s 1.6s kill timeout', exit?.code === 0 && exit.ms < 1600, exit)
} catch (err) {
  check(`run threw: ${err.stack}`, false)
} finally {
  for (const port of [...servers.keys()]) await killServer(port)
  discord.hanging.forEach((r) => r.destroy())
  fake.close()
  try { sql('DROP TRIGGER IF EXISTS e2e_fail_order; DROP TRIGGER IF EXISTS e2e_fail_job') } catch {}
  const events = await prisma.event.findMany({ where: { venueId: venue.id }, select: { id: true } })
  const ids = events.map((e) => e.id)
  const orders = await prisma.merchPreorder.findMany({ where: { eventId: { in: ids } }, select: { id: true } })
  await prisma.outboxJob.deleteMany({ where: { dedupeKey: { in: orders.map((o) => `supply:${o.id}`) } } })
  await prisma.merchPreorder.deleteMany({ where: { eventId: { in: ids } } })
  await prisma.event.deleteMany({ where: { id: { in: ids } } })
  await prisma.venue.delete({ where: { id: venue.id } })
  await prisma.auditLog.deleteMany({ where: { actorLabel: { startsWith: 'E2E ' } } })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
failures.forEach((f) => console.log(`  ✗ ${f}`))
process.exit(failures.length ? 1 : 0)
