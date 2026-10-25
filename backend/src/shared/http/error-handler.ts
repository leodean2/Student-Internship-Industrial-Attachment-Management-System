import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { AppError, Errors, type ErrorCode } from "../errors";

interface ErrorBody {
  error: { code: ErrorCode; message: string; requestId: string; details?: unknown };
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(Errors.notFound("Route not found."));
};

/**
 * The only place an error becomes an HTTP response (#55). Unexpected errors are logged with
 * full detail server-side and returned to the client with NO internal detail.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.requestId ?? "unknown";
  let status = 500;
  let code: ErrorCode = "INTERNAL_ERROR";
  let message = "An unexpected error occurred.";
  let details: unknown;

  if (err instanceof AppError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    status = 400;
    code = "VALIDATION_ERROR";
    message = "The request is invalid.";
    // Field path + message only: never echo submitted values back.
    details = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  } else if ((err as { type?: string })?.type === "entity.parse.failed") {
    status = 400;
    code = "VALIDATION_ERROR";
    message = "The request body is not valid JSON.";
  } else if ((err as { type?: string })?.type === "entity.too.large") {
    status = 400;
    code = "VALIDATION_ERROR";
    message = "The request body is too large.";
  }

  if (status >= 500) {
    (req.log ?? console).error({ err }, "unhandled error");
  }

  res.locals.errorCode = code; // read by the request logger
  const body: ErrorBody = { error: { code, message, requestId } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
};
