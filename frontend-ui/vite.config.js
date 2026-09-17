import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// base: '/events/' because Express serves this build's assets from under /events
// (see src/app.js) — asset URLs need that prefix baked in to resolve correctly.
export default defineConfig({
  base: '/events/',
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Libraries change far less often than the app, and every deploy renames the app's
          // files. In chunks of their own, a returning visitor re-downloads only what changed.
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'msal', test: /node_modules[\\/]@azure[\\/]/ },
          ],
        },
      },
    },
  },
})
