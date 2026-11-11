import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { acquireTransactionLock, invitationEmailLockKey } from "../../infrastructure/advisory-lock";
import type { Tx, TxRunner } from "../../infrastructure/transaction";
import { AttemptLimiter } from "../../shared/security/attempt-limiter";
import { isUniqueViolation } from "../../shared/db/errors";
import { Errors } from "../../shared/errors";
import { hashToken, mintOpaqueToken } from "../../shared/security/opaque-token";
import { normalizeEmail } from "../../shared/validation/email";
import { hashPassword } from "../auth/password";
import type { AuditRepository } from "../audit/audit.repository";
import { enqueueEmailVerificationRequested } from "../email-outbox/email-verification-requested.producer";
import type { OutboxEnqueuer } from "../email-outbox/outbox.repository";
import type { EmailVerificationTokenRepository } from "./email-verification-token.repository";
import type { StudentRegistrationRepository } from "./student-registration.repository";
import type { RegisterStudentInput, VerifyEmailInput } from "./student-registration.validation";

const HOUR_MS = 60 * 60 * 1000;
export const REGISTRATION_IP_LIMIT = 10;
export const REGISTRATION_EMAIL_LIMIT = 5;
export const REGISTRATION_WINDOW_MS = HOUR_MS;
export const VERIFY_ATTEMPT_LIMIT = 10;
export const VERIFY_WINDOW_MS = 15 * 60 * 1000;

export const REGISTRATION_ACCEPTED_MESSAGE =
  "If these details can be used to create an account, a verification email is on its way. Check your inbox.";
const REGISTRATION_NUMBER_TAKEN = "This registration number is already registered.";
const INVALID_LINK = "This verification link is invalid or has expired.";

export interface RequestContext {
  ip: string;
}

export interface StudentRegistrationServiceDeps {
  users: StudentRegistrationRepository;
  tokens: EmailVerificationTokenRepository;
  outbox: OutboxEnqueuer;
  audit: AuditRepository;
  appBaseUrl: string;
  runTx: TxRunner;
  acquireLock?: (tx: Tx, key: string) => Promise<void>;
  registrationIpThrottle?: Pick<AttemptLimiter, "acquire">;
  registrationEmailThrottle?: Pick<AttemptLimiter, "acquire">;
  verifyThrottle?: Pick<AttemptLimiter, "acquire">;
  verifyAttemptLimit?: number;
  verifyWindowMs?: number;
  hashPassword?: (plain: string) => Promise<string>;
}

function uniqueViolationField(error: unknown): "email" | "registrationNumber" | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    const detail = `${JSON.stringify(error.meta ?? {})} ${error.message}`.toLowerCase();
    if (detail.includes("registrationnumber") || detail.includes("registration_number")) return "registrationNumber";
    if (detail.includes("email")) return "email";
  }
  if (isUniqueViolation(error)) {
    const detail = error instanceof Error ? error.message.toLowerCase() : "";
    if (detail.includes("registrationnumber") || detail.includes("registration_number")) return "registrationNumber";
    if (detail.includes("users_email") || detail.includes("email")) return "email";
  }
  return null;
}

export class StudentRegistrationService {
  private readonly acquireLock: (tx: Tx, key: string) => Promise<void>;
  private readonly registrationIpThrottle: Pick<AttemptLimiter, "acquire">;
  private readonly registrationEmailThrottle: Pick<AttemptLimiter, "acquire">;
  private readonly verifyThrottle: Pick<AttemptLimiter, "acquire">;
  private readonly hashPassword: (plain: string) => Promise<string>;

  constructor(private readonly deps: StudentRegistrationServiceDeps) {
    this.acquireLock = deps.acquireLock ?? acquireTransactionLock;
    this.registrationIpThrottle =
      deps.registrationIpThrottle ?? new AttemptLimiter({ limit: REGISTRATION_IP_LIMIT, windowMs: REGISTRATION_WINDOW_MS });
    this.registrationEmailThrottle =
      deps.registrationEmailThrottle ??
      new AttemptLimiter({ limit: REGISTRATION_EMAIL_LIMIT, windowMs: REGISTRATION_WINDOW_MS });
    this.verifyThrottle =
      deps.verifyThrottle ??
      new AttemptLimiter({
        limit: deps.verifyAttemptLimit ?? VERIFY_ATTEMPT_LIMIT,
        windowMs: deps.verifyWindowMs ?? VERIFY_WINDOW_MS,
      });
    this.hashPassword = deps.hashPassword ?? hashPassword;
  }

  async register(input: RegisterStudentInput, context: RequestContext): Promise<{ message: string }> {
    const email = normalizeEmail(input.email);
    const ip = this.registrationIpThrottle.acquire(`register:ip:${context.ip}`);
    if (!ip.allowed) throw Errors.rateLimited(ip.retryAfterSeconds);
    const mailbox = this.registrationEmailThrottle.acquire(`register:email:${email}`);
    if (!mailbox.allowed) throw Errors.rateLimited(mailbox.retryAfterSeconds);

    const passwordHash = await this.hashPassword(input.password);
    const { raw, hash } = mintOpaqueToken();
    const userId = randomUUID();
    const { users, tokens, outbox, audit, appBaseUrl, runTx } = this.deps;

    try {
      await runTx(async (tx) => {
        await this.acquireLock(tx, invitationEmailLockKey(email));

        if (await users.accountExists(tx, email)) return;
        if (await users.registrationNumberExists(tx, input.registrationNumber)) {
          throw Errors.conflict(REGISTRATION_NUMBER_TAKEN);
        }

        await users.insertUser(tx, { id: userId, email, name: input.name, passwordHash });
        await users.insertStudentRole(tx, userId);
        await users.insertStudentProfile(tx, { userId, registrationNumber: input.registrationNumber });
        const { expiresAt } = await tokens.insert(tx, { userId, tokenHash: hash });
        await enqueueEmailVerificationRequested(outbox, tx, {
          toEmail: email,
          userId,
          rawToken: raw,
          tokenHash: hash,
          expiresAt,
          appBaseUrl,
        });
        await audit.record(tx, {
          actorUserId: userId,
          action: "STUDENT_REGISTERED",
          targetType: "User",
          targetId: userId,
          metadata: { role: "STUDENT" },
        });
      });
    } catch (error) {
      const field = uniqueViolationField(error);
      if (field === "registrationNumber") throw Errors.conflict(REGISTRATION_NUMBER_TAKEN);
      if (field === "email") return { message: REGISTRATION_ACCEPTED_MESSAGE };
      throw error;
    }

    return { message: REGISTRATION_ACCEPTED_MESSAGE };
  }

  async verifyEmail(input: VerifyEmailInput, context: RequestContext): Promise<{ emailVerified: true }> {
    const attempt = this.verifyThrottle.acquire(`verify:ip:${context.ip}`);
    if (!attempt.allowed) throw Errors.rateLimited(attempt.retryAfterSeconds);
    let failedTokenGuess = false;

    try {
      const tokenHash = hashToken(input.token);
      const { users, tokens, audit, runTx } = this.deps;
      await runTx(async (tx) => {
        const consumed = await tokens.consume(tx, tokenHash);
        // Email verification proves mailbox ownership only; institutional confirmation is required for activation.
        if (!consumed || !(await users.markEmailVerified(tx, consumed.userId))) {
          failedTokenGuess = true;
          throw Errors.notFound(INVALID_LINK);
        }
        // TODO(C1 activation): an authorized registration-number confirmation must move the user to ACTIVE,
        // and must require emailVerifiedAt IS NOT NULL.
        await audit.record(tx, {
          actorUserId: consumed.userId,
          action: "EMAIL_VERIFIED",
          targetType: "User",
          targetId: consumed.userId,
          metadata: {},
        });
      });
      return { emailVerified: true };
    } finally {
      if (!failedTokenGuess) attempt.permit.refund();
    }
  }
}
