import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger };

/**
 * Structured JSON logging (#55). The redaction list encodes the "never log" rule:
 * credentials and tokens must not appear in logs even if a developer logs a whole object by mistake.
 * Request/response BODIES are never logged by the request logger at all.
 */
/**
 * Pino wildcards such as "*.password" match that key one nesting level down. Redaction is a safety net, not the
 * control: request and response bodies must never be logged. Recursive redaction is deliberately deferred.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.tokenHash",
  "*.secret",
  "*.authorization",
  // Outbox worker claim ownership tokens (Decision #54 §14). `*.token` does NOT match `claimToken`.
  "*.claimToken",
  "acceptanceUrl",
  "*.acceptanceUrl",
  "verificationUrl",
  "*.verificationUrl",
  "resetUrl",
  "*.resetUrl",
  // Phone numbers are PII and must not appear in logs (C1-F).
  "*.phone",
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, destination);
}
