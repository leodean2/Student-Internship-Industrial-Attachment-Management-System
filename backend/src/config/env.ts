import { z } from "zod";

const logLevel = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info");

const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_BASE_URL: z.string().refine(isHttpUrl, "APP_BASE_URL must be an absolute http(s) URL").optional(),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  CORS_ORIGIN: z
    .string()
    .min(1, "CORS_ORIGIN is required (comma-separated allow-list)")
    // Requests are credentialed (refresh cookie), so a wildcard origin is never acceptable (Decision #78).
    .refine((v) => !v.split(",").some((o) => o.trim() === "*"), "CORS_ORIGIN must list explicit origins, never '*'"),
  REFRESH_COOKIE_SAMESITE: z.enum(["strict", "lax", "none"]).default("strict"),
  EMAIL_VERIFY_FAILED_ATTEMPT_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),
  EMAIL_VERIFY_WINDOW_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(900_000),
  LOG_LEVEL: logLevel,
  // Number of reverse proxies in front of the API (Render: 1). Too high lets clients spoof their IP and dodge login throttling.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  // Per-email password-reset request limit per hour (C2 decision). Default: 3.
  PASSWORD_RESET_EMAIL_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(100).default(3),
  // Optional stable key for HMAC throttle-key hashing. Unset = random per-process key (correct for the in-memory store).
  THROTTLE_KEY_SECRET: z.string().min(32).optional(),
}).superRefine((v, ctx) => {
  if (v.NODE_ENV === "production" && !v.APP_BASE_URL) {
    ctx.addIssue({
      code: "custom",
      path: ["APP_BASE_URL"],
      message: "APP_BASE_URL is required in production",
    });
  }
  if (v.NODE_ENV === "production" && v.APP_BASE_URL && !v.APP_BASE_URL.startsWith("https://")) {
    ctx.addIssue({
      code: "custom",
      path: ["APP_BASE_URL"],
      message: "APP_BASE_URL must use https in production",
    });
  }
}).transform((v) => ({ ...v, APP_BASE_URL: v.APP_BASE_URL ?? "http://localhost:5173" }));

export type Env = z.infer<typeof schema>;

/** Field path + message only: submitted values are never echoed (secrets must not reach logs, #55). */
function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

/**
 * Validates configuration once at startup. On failure it reports WHICH variables
 * are wrong but never echoes their values (secrets must not reach logs, #55).
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n  - ${formatIssues(parsed.error).join("\n  - ")}`);
  }
  return parsed.data;
}

export function parseCorsOrigins(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Email outbox worker configuration (Decision #54 §3). The worker is a separate process and needs
// neither the JWT secret nor the CORS list, so it has its own schema.
// ---------------------------------------------------------------------------------------------

/** Fixed slack added to the shutdown sizing rule: DB writes + Prisma disconnect (Decision #54 §3, Rule 1). */
export const SHUTDOWN_SLACK_MS = 10_000;

const workerSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    LOG_LEVEL: logLevel,
    EMAIL_PROVIDER: z.enum(["log", "resend"]).default("log"),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
    WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(5),
    WORKER_LEASE_DURATION_MS: z.coerce.number().int().min(30_000).default(60_000),
    WORKER_LEASE_RENEWAL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(20_000),
    WORKER_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(30_000),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(30_000).default(90_000),
  })
  // Cross-field rules run only when every individual field is valid. The numeric (non-secret) values are
  // named in these messages as Decision #54 §3 requires; DATABASE_URL is never part of any message.
  .superRefine((v, ctx) => {
    if (v.NODE_ENV === "production" && v.EMAIL_PROVIDER === "log") {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_PROVIDER"],
        message: "EMAIL_PROVIDER=log is not allowed in production",
      });
    }
    if (v.EMAIL_PROVIDER === "resend") {
      if (!v.RESEND_API_KEY) {
        ctx.addIssue({
          code: "custom",
          path: ["RESEND_API_KEY"],
          message: "RESEND_API_KEY is required when EMAIL_PROVIDER=resend",
        });
      }
      if (!v.EMAIL_FROM) {
        ctx.addIssue({
          code: "custom",
          path: ["EMAIL_FROM"],
          message: "EMAIL_FROM is required when EMAIL_PROVIDER=resend",
        });
      }
    }
    if (v.WORKER_CONCURRENCY > v.WORKER_BATCH_SIZE) {
      ctx.addIssue({
        code: "custom",
        path: ["WORKER_CONCURRENCY"],
        message: `WORKER_CONCURRENCY (${v.WORKER_CONCURRENCY}) must not exceed WORKER_BATCH_SIZE (${v.WORKER_BATCH_SIZE})`,
      });
    }
    const minLease = v.WORKER_LEASE_RENEWAL_INTERVAL_MS * 3;
    if (v.WORKER_LEASE_DURATION_MS < minLease) {
      ctx.addIssue({
        code: "custom",
        path: ["WORKER_LEASE_DURATION_MS"],
        message:
          `WORKER_LEASE_DURATION_MS (${v.WORKER_LEASE_DURATION_MS}) must be at least 3 x ` +
          `WORKER_LEASE_RENEWAL_INTERVAL_MS (${v.WORKER_LEASE_RENEWAL_INTERVAL_MS}) = ${minLease}`,
      });
    }
    const minShutdown =
      Math.ceil(v.WORKER_BATCH_SIZE / v.WORKER_CONCURRENCY) * v.WORKER_PROVIDER_TIMEOUT_MS + SHUTDOWN_SLACK_MS;
    if (v.SHUTDOWN_TIMEOUT_MS < minShutdown) {
      ctx.addIssue({
        code: "custom",
        path: ["SHUTDOWN_TIMEOUT_MS"],
        message:
          `SHUTDOWN_TIMEOUT_MS (${v.SHUTDOWN_TIMEOUT_MS}) must be at least ` +
          `ceil(WORKER_BATCH_SIZE (${v.WORKER_BATCH_SIZE}) / WORKER_CONCURRENCY (${v.WORKER_CONCURRENCY})) x ` +
          `WORKER_PROVIDER_TIMEOUT_MS (${v.WORKER_PROVIDER_TIMEOUT_MS}) + ${SHUTDOWN_SLACK_MS} = ${minShutdown}`,
      });
    }
  });

export type WorkerEnv = z.infer<typeof workerSchema>;

/** Same conventions as loadEnv(): validate once at startup, name the variables, never echo secrets. */
export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = workerSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid worker environment configuration:\n  - ${formatIssues(parsed.error).join("\n  - ")}`);
  }
  return parsed.data;
}
