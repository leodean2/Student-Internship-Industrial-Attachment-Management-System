import { API_BASE_URL } from "../config";

export type ApiFailure = "rate_limited" | "validation" | "rejected" | "server" | "network";

export type ApiResult =
  | { ok: true }
  | { ok: false; failure: ApiFailure; retryAfterSeconds: number | null };

function classify(status: number): ApiFailure {
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "validation";
  if (status >= 500) return "server";
  return "rejected";
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : null;
}

export async function postJson(
  path: string,
  body: unknown,
  options: { credentials?: RequestCredentials } = {},
): Promise<ApiResult> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: options.credentials ?? "omit",
      cache: "no-store",
    });
  } catch {
    return { ok: false, failure: "network", retryAfterSeconds: null };
  }
  if (response.ok) return { ok: true };
  return {
    ok: false,
    failure: classify(response.status),
    retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")),
  };
}
