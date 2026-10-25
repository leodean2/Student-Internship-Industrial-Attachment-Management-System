import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import type { Logger } from "../../infrastructure/logger";

/** Assigns a correlation id and a request-scoped logger to every request. */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    // Never trust a client-supplied id for correlation: generate our own.
    const requestId = randomUUID();
    req.requestId = requestId;
    req.log = logger.child({ requestId });
    res.setHeader("X-Request-Id", requestId);
    next();
  };
}

/**
 * One structured line per request: requestId, method, path, status, duration, actor, error code.
 * Bodies, query strings with secrets and headers are intentionally NOT logged (#55 never-log list).
 */
export function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      req.log.info({
        method: req.method,
        // Full request path with the query string stripped (query strings can carry secrets).
        // Not derived from req.baseUrl/req.route: Express unwinds those before `finish` on error paths.
        path: req.originalUrl.split("?")[0],
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        userId: req.actor?.userId,
        roles: req.actor ? [...req.actor.roles].sort() : undefined,
        errorCode: res.locals.errorCode,
      }, "request completed");
    });
    next();
  };
}
