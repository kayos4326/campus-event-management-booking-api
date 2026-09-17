import axios from "axios";
import { loginRequest } from "./authConfig";

// Relative path — same-origin once deployed under /events (matches the lab's own
// "no hardcoded domains" convention). .env.development overrides this for `npm run
// dev` to hit the real deployed backend, since there's no separate local backend+DB.
const API_BASE = import.meta.env.VITE_API_BASE || "/events/api";

// Cover images come back as server-absolute paths ("/events/api/events/7/image/<key>"),
// which is right in production, where the API and the app share an origin. When the API
// lives somewhere else (npm run dev, the e2e build) they need its origin in front.
const API_ORIGIN = /^https?:\/\//.test(API_BASE) ? new URL(API_BASE).origin : "";

export const mediaUrl = (path) => (path ? `${API_ORIGIN}${path}` : null);

export function createApiClient(msalInstance, account) {
  const client = axios.create({ baseURL: API_BASE });

  client.interceptors.request.use(async (config) => {
    const result = await msalInstance.acquireTokenSilent({ ...loginRequest, account });
    config.headers.Authorization = `Bearer ${result.accessToken}`;
    return config;
  });

  return client;
}
