/**
 * Error taxonomy from Decision #55:
 *   400 validation | 401 authentication | 403 role/relationship denial |
 *   404 not found (also used to conceal existence) | 409 conflict | 429 rate limited | 500 unexpected
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
  | "RATE_LIMITED"
  | "INVITATION_ALREADY_ACCEPTED"
  | "INVITATION_ALREADY_CANCELLED"
  | "INVITATION_EXPIRED"
  | "INVITATION_STATE_CONFLICT"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    /** When set, the error handler sends it as the Retry-After header (seconds). */
    public readonly retryAfterSeconds?: number,
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
  invitationAlreadyAccepted: () =>
    new AppError(409, "INVITATION_ALREADY_ACCEPTED", "This invitation has already been accepted."),
  invitationAlreadyCancelled: () =>
    new AppError(409, "INVITATION_ALREADY_CANCELLED", "This invitation has already been cancelled."),
  invitationExpired: () => new AppError(409, "INVITATION_EXPIRED", "This invitation has expired."),
  invitationStateConflict: () =>
    new AppError(409, "INVITATION_STATE_CONFLICT", "The invitation changed before the request could complete."),
  /** Throttled. Says nothing about WHICH limit tripped. */
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(429, "RATE_LIMITED", "Too many attempts. Please try again later.", undefined, retryAfterSeconds),
};
