import { API_BASE_URL } from "../config";

export type ApiFailure = "rate_limited" | "validation" | "rejected" | "server" | "network";

export type ApiResult =
  | { ok: true }
  | { ok: false; failure: ApiFailure; retryAfterSeconds: number | null };

export type ApiJsonResult =
  | { ok: true; data: unknown }
  | { ok: false; failure: ApiFailure; retryAfterSeconds: number | null };

type RequestOutcome =
  | { response: Response }
  | { failure: ApiFailure; retryAfterSeconds: number | null };

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

async function sendJson(
  path: string,
  body: unknown,
  options: { credentials?: RequestCredentials } = {},
): Promise<RequestOutcome> {
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
    return { failure: "network", retryAfterSeconds: null };
  }
  return { response };
}

function failureForResponse(response: Response) {
  return {
    ok: false as const,
    failure: classify(response.status),
    retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")),
  };
}

export async function postJson(
  path: string,
  body: unknown,
  options: { credentials?: RequestCredentials } = {},
): Promise<ApiResult> {
  const outcome = await sendJson(path, body, options);
  if ("failure" in outcome) return { ok: false, ...outcome };
  if (outcome.response.ok) return { ok: true };
  return failureForResponse(outcome.response);
}

export async function postJsonForData(
  path: string,
  body: unknown,
  options: { credentials?: RequestCredentials } = {},
): Promise<ApiJsonResult> {
  const outcome = await sendJson(path, body, options);
  if ("failure" in outcome) return { ok: false, ...outcome };
  if (!outcome.response.ok) return failureForResponse(outcome.response);

  try {
    return { ok: true, data: await outcome.response.json() };
  } catch {
    return { ok: false, failure: "server", retryAfterSeconds: null };
  }
}
