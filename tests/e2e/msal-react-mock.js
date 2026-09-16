// E2E only: stands in for @azure/msal-react. The signed-in "account" is the e2e test
// user id in sessionStorage (per tab, like the real MSAL cache); that id is sent as the
// bearer token to the e2e server, and is what lib/sessionHandoff.js copies between tabs.
const KEY = 'e2eUser'
const current = () => sessionStorage.getItem(KEY)
const instance = {
  loginRedirect() { window.__e2eLoginRedirect = (window.__e2eLoginRedirect || 0) + 1 },
  logoutRedirect() { sessionStorage.removeItem(KEY); sessionStorage.setItem('e2eLoggedOut', '1'); location.reload() },
  acquireTokenSilent: async () => ({ accessToken: current() }),
}
export const MsalProvider = ({ children }) => children
export const useMsal = () => ({ instance, accounts: current() ? [{ username: current() }] : [] })
export const useIsAuthenticated = () => !!current()
