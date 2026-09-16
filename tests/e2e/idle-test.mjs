// Shared-computer safety: an idle tab warns, then signs itself out.
// Run against a build made with a short VITE_IDLE_MINUTES (see README) so it takes seconds.
import puppeteer from 'puppeteer-core'

const APP = 'http://127.0.0.1:4173/events/'
const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} [idle sign-out] ${name}${!ok && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`) }
const waitFor = (page, text, timeout = 30000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text).then(() => true).catch(() => false)

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  userDataDir: new URL('./chrome-profile-idle', import.meta.url).pathname,
  defaultViewport: { width: 1200, height: 820 },
})
const page = (await browser.pages())[0]
await page.goto(APP, { waitUntil: 'domcontentloaded' })
await page.evaluate(() => sessionStorage.setItem('e2eUser', 'e2e-s1'))
await page.goto(APP, { waitUntil: 'domcontentloaded' })
await waitFor(page, 'Discover events')

check('an idle tab warns before signing out', await waitFor(page, 'Still there?'))
await page.evaluate(() => [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.trim() === 'Stay signed in').click())
check('"Stay signed in" dismisses the warning and keeps you in',
  await page.waitForFunction(() => !document.body.innerText.includes('Still there?') && document.body.innerText.includes('Discover events'), { timeout: 5000 }).then(() => true).catch(() => false))

check('the warning comes back when the tab stays idle', await waitFor(page, 'Still there?'))
check('an abandoned tab signs itself out', await waitFor(page, 'Sign in with Microsoft'))
check('…and the session is cleared', (await page.evaluate(() => sessionStorage.getItem('e2eUser'))) === null)

await browser.close()
console.log(`\n${results.filter(Boolean).length}/${results.length} idle checks passed`)
