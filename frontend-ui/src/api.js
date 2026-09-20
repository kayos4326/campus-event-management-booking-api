import axios from "axios";
import { loginRequest } from "./authConfig";

// Production uses the same origin; development may override the API base URL.
const API_BASE = import.meta.env.VITE_API_BASE || "/events/api";

// Prefix media paths when the development UI and API use different origins.
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
