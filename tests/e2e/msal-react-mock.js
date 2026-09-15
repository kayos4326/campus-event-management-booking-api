// E2E only: stands in for @azure/msal-react. The signed-in "account" is the e2e test
// user id in localStorage; that id is sent as the bearer token to the e2e server.
const KEY = 'e2eUser'
const current = () => localStorage.getItem(KEY)
const instance = {
  loginRedirect() { window.__e2eLoginRedirect = (window.__e2eLoginRedirect || 0) + 1 },
  logoutRedirect() { localStorage.removeItem(KEY); sessionStorage.setItem('e2eLoggedOut', '1'); location.reload() },
  acquireTokenSilent: async () => ({ accessToken: current() }),
}
export const MsalProvider = ({ children }) => children
export const useMsal = () => ({ instance, accounts: current() ? [{ username: current() }] : [] })
export const useIsAuthenticated = () => !!current()
