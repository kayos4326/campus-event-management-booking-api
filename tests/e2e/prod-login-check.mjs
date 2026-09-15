// Live production site: real MSAL. Click "Sign in with Microsoft" and verify the redirect to
// Microsoft is correctly configured. Never types anything into the Microsoft page.
import puppeteer from 'puppeteer-core'

import fs from 'node:fs'
const SP = new URL('.', import.meta.url).pathname
fs.mkdirSync(`${SP}ui-shots`, { recursive: true })
const SITE = 'https://chaotic-hell.eastasia.cloudapp.azure.com/events/'
const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} [live site] ${name}${!ok && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`) }

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  userDataDir: `${SP}chrome-profile-prod`,
  defaultViewport: { width: 1280, height: 860 },
  args: ['--window-size=1300,960', '--no-first-run', '--no-default-browser-check'],
})
const page = (await browser.pages())[0]
const errors = []
let onMicrosoft = false // Microsoft's own page has its own noise (e.g. a 404 for its favicon) — not ours
page.on('console', (m) => { if (m.type() === 'error' && !onMicrosoft) errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(`PAGE ERROR: ${e.message}`))
const failedAssets = []
page.on('response', (r) => { if (r.url().startsWith(SITE) && r.status() >= 400) failedAssets.push(`${r.status()} ${r.url()}`) })

await page.goto(SITE, { waitUntil: 'networkidle0' })
const text = await page.evaluate(() => document.body.innerText)
check('live /events/ renders the new sign-in page', text.includes('Sign in with Microsoft') && text.includes('one seat'))
check('no failed same-site requests (JS, CSS, favicon)', failedAssets.length === 0, failedAssets)
check('fonts loaded (Bricolage Grotesque + Inter)', await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('700 20px "Bricolage Grotesque"') && document.fonts.check('16px Inter') }))
check('favicon is the new ticket icon', await page.evaluate(async () => (await (await fetch(document.querySelector('link[rel=icon]').href)).text()).includes('#ff5a36')))
check('no console errors on the live app', errors.length === 0, errors.slice(0, 5))
await page.screenshot({ path: `${SP}ui-shots/live-signin.png` })
onMicrosoft = true

const [nav] = await Promise.all([
  page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
  page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Sign in with Microsoft')).click()),
])
const url = new URL(page.url())
const p = url.searchParams
check('redirects to login.microsoftonline.com', url.host === 'login.microsoftonline.com', url.host)
check('uses the AU tenant', url.pathname.startsWith('/c1f3dc23-b7f8-48d3-9b5d-2b12f158f01f/'), url.pathname)
check('client_id is the campus-event-api app', p.get('client_id') === 'f581260c-6bc3-4f8c-a711-ac2ca274f56b', p.get('client_id'))
check('redirect_uri is the production /events/ URL', p.get('redirect_uri') === SITE, p.get('redirect_uri'))
check('requests the API scope', (p.get('scope') || '').includes('api://f581260c-6bc3-4f8c-a711-ac2ca274f56b/access_as_user'), p.get('scope'))
check('authorization code flow with PKCE (S256)', p.get('response_type') === 'code' && p.get('code_challenge_method') === 'S256' && !!p.get('code_challenge'))
await page.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => {})
const msText = await page.evaluate(() => document.body.innerText)
check('Microsoft shows its sign-in page (no AADSTS configuration error)', !/AADSTS\d+/.test(msText) && /sign in|email|pick an account/i.test(msText), msText.slice(0, 300))
await page.screenshot({ path: `${SP}ui-shots/live-microsoft-signin.png` })

await browser.close()
console.log(`\n${results.filter(Boolean).length}/${results.length} live-site checks passed`)
