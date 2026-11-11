import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../modules/auth/password";
import { checkPassword, PASSWORD_POLICY_MESSAGE } from "../modules/auth/password-policy";
import { normalizeEmail } from "../shared/validation/email";
import { SYSTEM_USER_ID } from "../shared/system-user";

// ── Constants ────────────────────────────────────────────────────────────────

const ADVISORY_LOCK_KEY = "hashtext('bootstrap:admin:lock')";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BootstrapDeps {
  countAdmins: () => Promise<number>;
  insertUser: (data: { id: string; email: string; passwordHash: string; name: string }) => Promise<void>;
  insertRole: (data: { id: string; userId: string }) => Promise<void>;
  insertAdminProfile: (data: { id: string; userId: string }) => Promise<void>;
  insertAuditLog: (data: { id: string; actorUserId: string; targetId: string; email: string }) => Promise<void>;
  hashPassword: (plain: string) => Promise<string>;
}

export interface BootstrapInput {
  email: string;
  name: string;
  password: string;
}

export type BootstrapResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "admin_exists" | "validation_error"; message: string };

// ── Pure logic (fully testable, no I/O) ─────────────────────────────────────

export async function runBootstrap(deps: BootstrapDeps, input: BootstrapInput): Promise<BootstrapResult> {
  const email = normalizeEmail(input.email);

  if (!isValidEmail(email)) {
    return { ok: false, reason: "validation_error", message: "Invalid email format." };
  }

  const nameError = validateName(input.name);
  if (nameError) {
    return { ok: false, reason: "validation_error", message: nameError };
  }

  const passwordCheck = checkPassword(input.password);
  if (!passwordCheck.ok) {
    return { ok: false, reason: "validation_error", message: PASSWORD_POLICY_MESSAGE };
  }

  const count = await deps.countAdmins();
  if (count > 0) {
    return { ok: false, reason: "admin_exists", message: "Admin already exists. Bootstrap aborted." };
  }

  const userId = randomUUID();
  const passwordHash = await deps.hashPassword(input.password);

  await deps.insertUser({ id: userId, email, passwordHash, name: input.name });
  await deps.insertRole({ id: randomUUID(), userId });
  await deps.insertAdminProfile({ id: randomUUID(), userId });
  await deps.insertAuditLog({ id: randomUUID(), actorUserId: SYSTEM_USER_ID, targetId: userId, email });

  return { ok: true, userId };
}

// ── Validation helpers ───────────────────────────────────────────────────────

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validateName(name: string): string | null {
  if (name.length === 0) return "Name must not be empty.";
  if (name.length > 100) return "Name must be 100 characters or fewer.";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return "Name must not contain control characters.";
  return null;
}

// ── CLI entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Load env
  const { config } = await import("dotenv");
  config();

  const databaseUrl = process.env["DATABASE_URL_UNPOOLED"];
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL_UNPOOLED is not set.");
    process.exit(1);
  }

  // 2. Print target host for confirmation
  const host = parseHost(databaseUrl);
  console.log(`\nTarget database: ${host}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));
  const askHidden = (q: string): Promise<string> =>
    new Promise((res) => {
      process.stdout.write(q);
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      let value = "";
      const onData = (ch: string) => {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          res(value);
        } else if (ch === "\u0003") {
          process.exit(1);
        } else if (ch === "\u007f") {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      };
      stdin.on("data", onData);
    });

  try {
    const confirm = await ask("Type 'yes' to confirm and continue: ");
    if (confirm.trim() !== "yes") {
      console.log("Aborted.");
      process.exit(0);
    }

    // 3. Prompt email
    const rawEmail = await ask("Email: ");
    const email = normalizeEmail(rawEmail);
    if (!isValidEmail(email)) {
      console.error("ERROR: Invalid email format.");
      process.exit(1);
    }

    // 4. Prompt name
    const name = await ask("Full name: ");
    const nameError = validateName(name);
    if (nameError) {
      console.error(`ERROR: ${nameError}`);
      process.exit(1);
    }

    // 5. Prompt password (hidden)
    const password = await askHidden("Password: ");
    const passwordCheck = checkPassword(password);
    if (!passwordCheck.ok) {
      console.error(`ERROR: ${PASSWORD_POLICY_MESSAGE}`);
      process.exit(1);
    }

    // 6. Confirm password
    const confirm2 = await askHidden("Confirm password: ");
    if (password !== confirm2) {
      console.error("ERROR: Passwords do not match.");
      process.exit(1);
    }

    rl.close();

    // 7. Open Prisma on direct connection
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

    try {
      // 8. Acquire session-scoped advisory lock
      await prisma.$executeRawUnsafe(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`);

      // 9. Run inside SERIALIZABLE transaction
      const result = await prisma.$transaction(
        async (tx) => {
          const deps: BootstrapDeps = {
            countAdmins: async () => {
              const rows = await tx.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*)::bigint AS count FROM admin_profiles`;
              return Number(rows[0]!.count);
            },
            insertUser: async (data) => {
              await tx.$executeRaw`
                INSERT INTO users (id, email, "passwordHash", name, status, "createdAt", "updatedAt")
                VALUES (${data.id}::uuid, ${data.email}, ${data.passwordHash}, ${data.name}, 'ACTIVE'::"UserStatus", now(), now())
              `;
            },
            insertRole: async (data) => {
              await tx.$executeRaw`
                INSERT INTO user_roles (id, "userId", role)
                VALUES (${data.id}::uuid, ${data.userId}::uuid, 'ADMIN'::"UserRoleName")
              `;
            },
            insertAdminProfile: async (data) => {
              await tx.$executeRaw`
                INSERT INTO admin_profiles (id, "userId")
                VALUES (${data.id}::uuid, ${data.userId}::uuid)
              `;
            },
            insertAuditLog: async (data) => {
              await tx.$executeRaw`
                INSERT INTO audit_logs (id, "actorUserId", action, "targetType", "targetId", metadata, "occurredAt")
                VALUES (
                  ${data.id}::uuid,
                  ${data.actorUserId}::uuid,
                  'ADMIN_BOOTSTRAP',
                  'User',
                  ${data.targetId},
                  ${JSON.stringify({ email: data.email })}::jsonb,
                  now()
                )
              `;
            },
            hashPassword,
          };

          return runBootstrap(deps, { email, name, password });
        },
        { isolationLevel: "Serializable" },
      );

      if (!result.ok) {
        console.error(`ERROR: ${result.message}`);
        process.exit(1);
      }

      console.log(`\nAdmin created successfully. userId: ${result.userId}`);
    } finally {
      await prisma.$disconnect();
    }
  } catch (err) {
    rl.close();
    console.error("ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function parseHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname.replace(/^\//, "") || "(default)"} on ${parsed.hostname}`;
  } catch {
    return "(unable to parse host)";
  }
}

main();
