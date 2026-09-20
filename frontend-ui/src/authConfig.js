// Public SPA registration in the AU Microsoft Entra tenant; no client secret belongs here.
export const msalConfig = {
  auth: {
    clientId: "f581260c-6bc3-4f8c-a711-ac2ca274f56b",
    authority: "https://login.microsoftonline.com/c1f3dc23-b7f8-48d3-9b5d-2b12f158f01f",
    redirectUri: window.location.origin + "/events/",
  },
  cache: {
    // Per-tab storage clears the session when the browser closes on a shared computer.
    cacheLocation: "sessionStorage",
    storeAuthStateInCookie: false,
  },
};

// The SPA requests the delegated scope exposed by this API's app registration.
export const loginRequest = {
  scopes: ["api://f581260c-6bc3-4f8c-a711-ac2ca274f56b/access_as_user"],
  // Always show the account chooser to protect users on shared computers.
  prompt: "select_account",
};

// Sign out abandoned sessions; the override supports development and automated tests.
export const IDLE_MINUTES = Number(import.meta.env.VITE_IDLE_MINUTES || 15);
export const IDLE_MS = IDLE_MINUTES * 60 * 1000;
export const IDLE_WARNING_MS = Math.min(60 * 1000, IDLE_MS / 3);
