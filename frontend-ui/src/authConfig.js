// AU tenant app registration — see CLAUDE.md §4. This is a public client (SPA), so no
// secret here; the client ID and tenant ID are not sensitive on their own.
export const msalConfig = {
  auth: {
    clientId: "f581260c-6bc3-4f8c-a711-ac2ca274f56b",
    authority: "https://login.microsoftonline.com/c1f3dc23-b7f8-48d3-9b5d-2b12f158f01f",
    redirectUri: window.location.origin + "/events/",
  },
  cache: {
    cacheLocation: "sessionStorage",
    storeAuthStateInCookie: false,
  },
};

// Matches the exposed API scope added 2026-09-10 (CLAUDE.md §4) — the app requesting a
// scope on itself, since there's no separate client app registration.
export const loginRequest = {
  scopes: ["api://f581260c-6bc3-4f8c-a711-ac2ca274f56b/access_as_user"],
};
