import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger };

/**
 * Structured JSON logging (#55). The redaction list encodes the "never log" rule:
 * credentials and tokens must not appear in logs even if a developer logs a whole object by mistake.
 * Request/response BODIES are never logged by the request logger at all.
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
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, destination);
}
