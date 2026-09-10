import axios from "axios";
import { loginRequest } from "./authConfig";

// Relative path — same-origin once deployed under /events (matches the lab's own
// "no hardcoded domains" convention). .env.development overrides this for `npm run
// dev` to hit the real deployed backend, since there's no separate local backend+DB.
const API_BASE = import.meta.env.VITE_API_BASE || "/events/api";

export function createApiClient(msalInstance, account) {
  const client = axios.create({ baseURL: API_BASE });

  client.interceptors.request.use(async (config) => {
    const result = await msalInstance.acquireTokenSilent({ ...loginRequest, account });
    config.headers.Authorization = `Bearer ${result.accessToken}`;
    return config;
  });

  return client;
}
