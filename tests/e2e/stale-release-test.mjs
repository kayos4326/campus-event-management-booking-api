// What a browser tab does when a deploy lands while it's open. Every release renames the
// app's files, so a tab from the old release can ask for a page's code that's gone:
//   1. it should reload once, pick up the new release, and carry on — still signed in;
//   2. if the new release's code still can't be fetched, it must not reload in a loop,
//      but show "Campus Events was just updated" with a Reload button that works.
//
// Needs the e2e API server on :3998 (README.md) and port 4173 free — this serves the build
// itself, straight from disk like Express does, so a rebuild really removes the old files.
import puppeteer from 'puppeteer-core'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const HERE = new URL('.', import.meta.url).pathname
const DIST = path.join(HERE, 'dist')
const APP = 'http://127.0.0.1:4173/events/'
const API = 'http://127.0.0.1:3998/events/api'

let passed = 0
const failures = []
const check = (name, ok, detail) => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) } else { failures.push(name); console.log(`  ✗ ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Two builds that differ, so every hashed file name changes between them, like a real deploy.
function buildRelease(idleMinutes) {
  const run = spawnSync(process.execPath, [path.join(HERE, 'serve-frontend.mjs'), '--build-only'], {
    env: { ...process.env, VITE_API_BASE: API, VITE_IDLE_MINUTES: String(idleMinutes) },
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`build failed:\n${run.stdout}\n${run.stderr}`)
  const assets = fs.readdirSync(path.join(DIST, 'assets'))
  return {
    entry: assets.find((f) => /^index-.*\.js$/.test(f)),
    organizer: assets.find((f) => /^OrganizerPanel-.*\.js$/.test(f)),
  }
}

// The production Content-Security-Policy and referrer policy, as serve-frontend.mjs uses.
const { cspDirectives, REFERRER_POLICY } = require('../../src/middleware/security.js')
const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
const policy = Object.entries(cspDirectives)
  .map(([name, values]) => `${kebab(name)} ${(name === 'connectSrc' || name === 'imgSrc' ? [...values, 'http://127.0.0.1:3998'] : values).join(' ')}`)
  .join('; ')
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, APP)
  const rel = url.pathname.replace(/^\/events\/?/, '') || 'index.html'
  const file = path.join(DIST, rel)
  const headers = { 'Content-Security-Policy': policy, 'Referrer-Policy': REFERRER_POLICY }
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { ...headers, 'content-type': 'text/html' })
    return res.end('Cannot GET')
  }
  res.writeHead(200, { ...headers, 'content-type': types[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

const oldRelease = buildRelease(15)
await new Promise((resolve) => server.listen(4173, '127.0.0.1', resolve))

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-first-run'],
})
const page = await browser.newPage()
page.setDefaultTimeout(20000)
let reloads = 0
page.on('load', () => { reloads += 1 }) // full page loads only, not tab changes in the URL hash
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

const loadedEntry = () => page.evaluate(() => [...document.querySelectorAll('script[type=module]')].map((s) => s.src).find((src) => /index-/.test(src)))
const openMyEvents = () => page.evaluate(() => [...document.querySelectorAll('nav button')].find((b) => b.innerText.includes('My events')).click())
const hasText = (text, timeout = 10000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text).then(() => true, () => false)

try {
  console.log(`\nA tab from release A, when release B lands before it has fetched a page's code`)
  // The organizer page's code is fetched in the background after sign-in. Hold that request
  // until the deploy has happened, so it arrives asking for a file that no longer exists.
  await page.setRequestInterception(true)
  let held = null
  page.on('request', (request) => {
    if (held === null && request.url().includes(oldRelease.organizer)) { held = request; return }
    if (!request.isInterceptResolutionHandled()) request.continue()
  })

  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { sessionStorage.setItem('e2eUser', 'e2e-org'); sessionStorage.removeItem('reloadedForNewRelease') })
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('nav'))
  const deadline = Date.now() + 10000
  while (!held && Date.now() < deadline) await sleep(50)
  check('release A asked for the organizer page in the background', !!held)
  check('…and is running release A', (await loadedEntry())?.includes(oldRelease.entry))

  // Count reloads from here: release B deletes A's files, and either the held script or the
  // page's stylesheet can be the request that notices first.
  reloads = 0
  const newRelease = buildRelease(16)
  check('release B renamed the files', newRelease.organizer !== oldRelease.organizer && newRelease.entry !== oldRelease.entry, [oldRelease, newRelease])
  check('release A\'s organizer code is gone from the server', !fs.existsSync(path.join(DIST, 'assets', oldRelease.organizer)))

  held.continue() // now it reaches the server, which has only release B
  await page.waitForFunction((entry) => [...document.querySelectorAll('script[type=module]')].some((s) => s.src.includes(entry)), { timeout: 15000 }, newRelease.entry).catch(() => {})
  check('the tab reloaded itself onto release B', (await loadedEntry())?.includes(newRelease.entry), await loadedEntry())
  check('…exactly once, however it found out', reloads === 1, reloads)
  await page.waitForFunction(() => document.querySelector('nav'))
  check('…and is still signed in', await page.evaluate(() => [...document.querySelectorAll('nav button')].some((b) => b.innerText.includes('My events'))))
  await openMyEvents()
  check('My events opens normally', await hasText('New event'))

  console.log(`\nWhen the new release's code can't be fetched either`)
  // Break release B's organizer file too: reloading can't help, so it must not loop.
  page.removeAllListeners('request')
  page.on('request', (request) => {
    if (request.url().includes(newRelease.organizer)) return request.respond({ status: 404, contentType: 'text/html', body: 'Cannot GET' })
    request.continue()
  })
  reloads = 0
  await page.goto(`${APP}#events`, { waitUntil: 'load' })
  await page.reload({ waitUntil: 'load' }) // a fresh load of release B, which now can't fetch the page's code
  await sleep(3000) // room for the one automatic reload it's allowed
  await page.waitForFunction(() => document.querySelector('nav'))
  await openMyEvents()
  check('opening the page shows a clear message instead of a blank screen', await hasText('Campus Events was just updated'))
  check('…after at most one automatic reload', reloads <= 3, reloads) // goto + reload + at most one more
  reloads = 0
  await sleep(2500)
  check('…and then no more reloads', reloads === 0, reloads)

  page.removeAllListeners('request')
  page.on('request', (request) => request.continue())
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('Reload')).click())
  await page.waitForFunction(() => document.querySelector('nav'), { timeout: 15000 })
  check('its Reload button brings the page back once the file is there', await hasText('New event'))
  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors)
} catch (err) {
  check(`run threw: ${err.message}`, false)
} finally {
  await browser.close()
  server.close()
}

console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
