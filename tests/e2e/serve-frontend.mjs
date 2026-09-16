// Builds the real frontend with @azure/msal-react swapped for msal-react-mock.js, pointed at
// the e2e server (through the SSH tunnel), and serves it at http://127.0.0.1:4173/events/.
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const frontend = fileURLToPath(new URL('../../frontend-ui/', import.meta.url))
const { build, preview } = await import(pathToFileURL(`${frontend}node_modules/vite/dist/node/index.js`).href)
const { default: react } = await import(pathToFileURL(`${frontend}node_modules/@vitejs/plugin-react/dist/index.js`).href)

process.env.VITE_API_BASE ||= 'http://127.0.0.1:3998/events/api'

// Serve the test build under the production Content-Security-Policy, so the e2e run
// catches anything the policy would block (map tiles, fonts, the API). The only change is
// allowing the tunnelled test API, which in production is the same origin as the app.
const { createRequire } = await import('node:module')
const { cspDirectives } = createRequire(import.meta.url)('../../src/middleware/security.js')
const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
const policy = Object.entries(cspDirectives)
  .map(([name, values]) => {
    const list = name === 'connectSrc' ? [...values, process.env.VITE_API_BASE.replace('/events/api', '')] : values
    return `${kebab(name)} ${list.join(' ')}`
  })
  .join('; ')

const config = {
  root: frontend,
  configFile: false,
  base: '/events/',
  plugins: [react()],
  resolve: { alias: [{ find: '@azure/msal-react', replacement: `${here}msal-react-mock.js` }] },
  build: { outDir: `${here}dist`, emptyOutDir: true },
  preview: { port: 4173, strictPort: true, host: '127.0.0.1', headers: { 'Content-Security-Policy': policy } },
}

await build(config)
if (process.argv[2] !== '--build-only') (await preview(config)).printUrls()
