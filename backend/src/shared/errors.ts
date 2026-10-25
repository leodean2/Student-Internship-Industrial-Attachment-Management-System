/**
 * Error taxonomy from Decision #55:
 *   400 validation | 401 authentication | 403 role/relationship denial |
 *   404 not found (also used to conceal existence) | 409 conflict | 500 unexpected
 * Every error reaches the client through ONE middleware as
 *   { error: { code, message, requestId } }
 */
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "TOKEN_EXPIRED"
  | "ACCOUNT_INACTIVE"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  validation: (details?: unknown, message = "The request is invalid.") =>
    new AppError(400, "VALIDATION_ERROR", message, details),
  /** Missing/malformed/forged token, or a user the token cannot be matched to. Deliberately uniform. */
  unauthenticated: (message = "Authentication is required.") => new AppError(401, "UNAUTHENTICATED", message),
  /** Distinct code so the client knows a refresh is the right response (refresh flow is built later). */
  tokenExpired: () => new AppError(401, "TOKEN_EXPIRED", "The access token has expired."),
  accountInactive: () => new AppError(401, "ACCOUNT_INACTIVE", "This account is not active."),
  forbidden: (message = "You do not have permission to perform this action.") =>
    new AppError(403, "FORBIDDEN", message),
  notFound: (message = "The requested resource was not found.") => new AppError(404, "NOT_FOUND", message),
  conflict: (message = "The request conflicts with the current state of the resource.") =>
    new AppError(409, "CONFLICT", message),
};
