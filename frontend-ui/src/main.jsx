import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PublicClientApplication, EventType } from '@azure/msal-browser'
import { MsalProvider } from '@azure/msal-react'
import './index.css'
import App from './App.jsx'
import { msalConfig } from './authConfig.js'
import { borrowSessionFromOpenTab, shareSessionWithNewTabs } from './lib/sessionHandoff.js'

const msalInstance = new PublicClientApplication(msalConfig)

// Each deploy is a new release with new file names, so a tab opened before it asks for code
// that no longer exists when it opens a page loaded on demand. Reload once to pick up the
// new release (the session is in sessionStorage, so you stay signed in). If that already
// happened a moment ago, let the error through to the page's error boundary rather than
// reloading in a loop.
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'reloadedForNewRelease'
  try {
    if (Date.now() - Number(sessionStorage.getItem(KEY) || 0) < 10000) return
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    return
  }
  event.preventDefault()
  window.location.reload()
})

// A second tab borrows the session from an open one, so you don't sign in again — but
// nothing is stored on disk, so closing every tab signs you out. See lib/sessionHandoff.js.
borrowSessionFromOpenTab().then(() => {
  shareSessionWithNewTabs()
  return msalInstance.initialize()
}).then(() => {
  const accounts = msalInstance.getAllAccounts()
  if (accounts.length > 0) {
    msalInstance.setActiveAccount(accounts[0])
  }

  msalInstance.addEventCallback((event) => {
    if (event.eventType === EventType.LOGIN_SUCCESS && event.payload.account) {
      msalInstance.setActiveAccount(event.payload.account)
    }
  })

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <MsalProvider instance={msalInstance}>
        <App />
      </MsalProvider>
    </StrictMode>,
  )
})
