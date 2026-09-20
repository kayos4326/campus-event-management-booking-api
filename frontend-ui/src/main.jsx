import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PublicClientApplication, EventType } from '@azure/msal-browser'
import { MsalProvider } from '@azure/msal-react'
import './index.css'
import App from './App.jsx'
import { msalConfig } from './authConfig.js'
import { borrowSessionFromOpenTab, shareSessionWithNewTabs } from './lib/sessionHandoff.js'

const msalInstance = new PublicClientApplication(msalConfig)

// Reload once when an older tab requests a lazy-loaded file removed by a new deployment.
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

// Share login only between currently open tabs, then initialize MSAL.
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
