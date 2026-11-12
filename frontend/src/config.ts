const raw = import.meta.env.VITE_API_BASE_URL as string | undefined;

/** Empty means same-origin requests (for example, when a reverse proxy serves the API). */
export const API_BASE_URL = (raw ?? "").replace(/\/+$/, "");
