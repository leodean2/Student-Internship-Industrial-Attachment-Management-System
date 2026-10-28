import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  CORS_ORIGIN: z
    .string()
    .min(1, "CORS_ORIGIN is required (comma-separated allow-list)")
    // Requests are credentialed (refresh cookie), so a wildcard origin is never acceptable (Decision #78).
    .refine((v) => !v.split(",").some((o) => o.trim() === "*"), "CORS_ORIGIN must list explicit origins, never '*'"),
  REFRESH_COOKIE_SAMESITE: z.enum(["strict", "lax", "none"]).default("strict"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Number of reverse proxies in front of the API (Render: 1). Too high lets clients spoof their IP and dodge login throttling.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
});

export type Env = z.infer<typeof schema>;

/**
 * Validates configuration once at startup. On failure it reports WHICH variables
 * are wrong but never echoes their values (secrets must not reach logs, #55).
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n  - ${problems.join("\n  - ")}`);
  }
  return parsed.data;
}

export function parseCorsOrigins(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
