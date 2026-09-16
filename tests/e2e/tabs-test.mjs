// The teacher's requirement: a second tab shouldn't ask you to sign in, but once every
// tab is closed (browser closed) you must sign in again. See src/lib/sessionHandoff.js.
import puppeteer from 'puppeteer-core'

const APP = 'http://127.0.0.1:4173/events/'
const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} [tabs] ${name}${!ok && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`) }
const signedIn = (page) => page.waitForFunction(() => document.body.innerText.includes('Discover events'), { timeout: 12000 }).then(() => true).catch(() => false)
const signInPage = (page) => page.waitForFunction(() => document.body.innerText.includes('Sign in with Microsoft'), { timeout: 12000 }).then(() => true).catch(() => false)

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  userDataDir: new URL('./chrome-profile-tabs', import.meta.url).pathname,
  defaultViewport: { width: 1100, height: 780 },
})

// Tab 1: sign in.
const tab1 = (await browser.pages())[0]
await tab1.goto(APP, { waitUntil: 'domcontentloaded' })
await tab1.evaluate(() => sessionStorage.setItem('e2eUser', 'e2e-s1'))
await tab1.goto(APP, { waitUntil: 'domcontentloaded' })
check('tab 1 is signed in', await signedIn(tab1))

// Tab 2 in the same browser: should be signed in without any click.
const tab2 = await browser.newPage()
await tab2.goto(APP, { waitUntil: 'domcontentloaded' })
check('a second tab goes straight into the app, no sign-in', await signedIn(tab2))
check('…because it borrowed the session, not because it was stored on disk',
  (await tab2.evaluate(() => sessionStorage.getItem('e2eUser'))) === 'e2e-s1' &&
  (await tab2.evaluate(() => localStorage.getItem('e2eUser'))) === null)

// Close every tab of the app — the same as closing the browser — then open it again.
await tab2.close()
await tab1.close()
const tab3 = await browser.newPage()
await tab3.goto(APP, { waitUntil: 'domcontentloaded' })
check('after every tab is closed, you have to sign in again', await signInPage(tab3))

// A different browser (separate profile) never shares anything.
const other = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: new URL('./chrome-profile-tabs-other', import.meta.url).pathname,
})
const otherTab = await other.newPage()
await otherTab.goto(APP, { waitUntil: 'domcontentloaded' })
check('a different browser has to sign in', await signInPage(otherTab))
await other.close()

await browser.close()
console.log(`\n${results.filter(Boolean).length}/${results.length} tab checks passed`)
