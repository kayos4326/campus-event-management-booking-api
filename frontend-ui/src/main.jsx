import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PublicClientApplication, EventType } from '@azure/msal-browser'
import { MsalProvider } from '@azure/msal-react'
import './index.css'
import App from './App.jsx'
import { msalConfig } from './authConfig.js'
import { borrowSessionFromOpenTab, shareSessionWithNewTabs } from './lib/sessionHandoff.js'

const msalInstance = new PublicClientApplication(msalConfig)

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
