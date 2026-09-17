// Builds the real frontend with @azure/msal-react swapped for msal-react-mock.js, pointed at
// the e2e server (through the SSH tunnel), and serves it at http://127.0.0.1:4173/events/.
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const frontend = fileURLToPath(new URL('../../frontend-ui/', import.meta.url))
const { build, preview } = await import(pathToFileURL(`${frontend}node_modules/vite/dist/node/index.js`).href)

process.env.VITE_API_BASE ||= 'http://127.0.0.1:3998/events/api'

// Serve the test build under the production Content-Security-Policy, so the e2e run
// catches anything the policy would block (map tiles, fonts, the API). The only change is
// allowing the tunnelled test API, which in production is the same origin as the app.
const { createRequire } = await import('node:module')
const { cspDirectives, REFERRER_POLICY } = createRequire(import.meta.url)('../../src/middleware/security.js')
const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
const policy = Object.entries(cspDirectives)
  .map(([name, values]) => {
    // Cover images and API calls come from the tunnelled test API, which in production is
    // the app's own origin and so already covered by 'self'.
    const apiOrigin = process.env.VITE_API_BASE.replace('/events/api', '')
    const list = name === 'connectSrc' || name === 'imgSrc' ? [...values, apiOrigin] : values
    return `${kebab(name)} ${list.join(' ')}`
  })
  .join('; ')

// The project's own vite.config.js (base path, React, chunking), so this build splits and
// lazy-loads exactly like production; only MSAL and the output folder differ.
const config = {
  root: frontend,
  configFile: `${frontend}vite.config.js`,
  resolve: { alias: [{ find: '@azure/msal-react', replacement: `${here}msal-react-mock.js` }] },
  build: { outDir: `${here}dist`, emptyOutDir: true },
  // The referrer policy too: without it this build sent a Referer that production didn't,
  // and OpenStreetMap blocked the live maps while every test here passed.
  preview: { port: 4173, strictPort: true, host: '127.0.0.1', headers: { 'Content-Security-Policy': policy, 'Referrer-Policy': REFERRER_POLICY } },
}

await build(config)
if (process.argv[2] !== '--build-only') (await preview(config)).printUrls()
