import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// base: '/events/' because Express serves this build's assets from under /events
// (see src/app.js) — asset URLs need that prefix baked in to resolve correctly.
export default defineConfig({
  base: '/events/',
  plugins: [react()],
})
