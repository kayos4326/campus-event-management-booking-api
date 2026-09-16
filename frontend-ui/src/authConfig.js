// AU tenant app registration — see CLAUDE.md §4. This is a public client (SPA), so no
// secret here; the client ID and tenant ID are not sensitive on their own.
export const msalConfig = {
  auth: {
    clientId: "f581260c-6bc3-4f8c-a711-ac2ca274f56b",
    authority: "https://login.microsoftonline.com/c1f3dc23-b7f8-48d3-9b5d-2b12f158f01f",
    redirectUri: window.location.origin + "/events/",
  },
  cache: {
    // Per-tab on purpose: these are shared lab computers, so closing the tab or the
    // browser must end the session rather than leave it for the next student.
    // (localStorage would keep everyone signed in across tabs — convenient, wrong here.)
    cacheLocation: "sessionStorage",
    storeAuthStateInCookie: false,
  },
};

// Matches the exposed API scope added 2026-09-10 (CLAUDE.md §4) — the app requesting a
// scope on itself, since there's no separate client app registration.
export const loginRequest = {
  scopes: ["api://f581260c-6bc3-4f8c-a711-ac2ca274f56b/access_as_user"],
  // Microsoft keeps its own sign-in cookie in the browser, so without this the next
  // student on a shared computer would be signed straight in as the previous one.
  // "select_account" always shows the account chooser first.
  prompt: "select_account",
};

// Shared computers again: an abandoned tab signs itself out. VITE_IDLE_MINUTES only
// exists so the e2e tests don't have to wait 15 real minutes.
export const IDLE_MINUTES = Number(import.meta.env.VITE_IDLE_MINUTES || 15);
export const IDLE_MS = IDLE_MINUTES * 60 * 1000;
export const IDLE_WARNING_MS = Math.min(60 * 1000, IDLE_MS / 3);
