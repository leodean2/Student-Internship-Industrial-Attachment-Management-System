import type { RequestHandler } from "express";
import { Errors } from "../errors";

/**
 * CSRF defence for cookie-authenticated endpoints (Decision #55): the request must carry an Origin header
 * that is on the CORS allow-list. Browsers always send Origin on cross-origin and on same-origin POSTs;
 * a missing Origin is therefore rejected rather than assumed safe. (This system's only client is the SPA.)
 */
export function requireAllowedOrigin(allowed: readonly string[]): RequestHandler {
  return (req, _res, next) => {
    const origin = req.headers.origin;
    if (!origin || !allowed.includes(origin)) throw Errors.forbidden("Request origin is not allowed.");
    next();
  };
}
