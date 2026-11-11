import { config } from "dotenv";
config();
import { PrismaPg } from "@prisma/adapter-pg";
import { createApp } from "./app";
import { loadEnv, parseCorsOrigins } from "./config/env";
import { createLogger } from "./infrastructure/logger";
import { createPrismaClient } from "./infrastructure/prisma";
import { ActorContextService } from "./modules/auth/actor-context.service";
import { PrismaAuthRepository } from "./modules/auth/auth.repository";
import { PrismaCredentialsRepository } from "./modules/auth/credentials.repository";
import { LoginThrottle } from "./modules/auth/login-throttle";
import { LoginService } from "./modules/auth/login.service";
import { getDummyHash, verifyPassword } from "./modules/auth/password";
import { PrismaRefreshTokenRepository } from "./modules/auth/refresh-token.repository";
import { DEFAULT_SESSION_CONFIG, type CookieConfig } from "./modules/auth/session.config";
import { SessionService } from "./modules/auth/session.service";
import { createTokenService } from "./modules/auth/token";
import { prismaTxRunner } from "./infrastructure/transaction";
import { PrismaAuditRepository } from "./modules/audit/audit.repository";
import { PrismaInvitationRepository } from "./modules/invitations/invitation.repository";
import { InvitationService } from "./modules/invitations/invitation.service";
import { PrismaOutboxRepository } from "./modules/outbox/outbox.repository";
import { PrismaEmailVerificationTokenRepository } from "./modules/student-registration/email-verification-token.repository";
import { PrismaStudentRegistrationRepository } from "./modules/student-registration/student-registration.repository";
import { StudentRegistrationService } from "./modules/student-registration/student-registration.service";
import { RegistrationReviewerService } from "./modules/registration-reviewer/registration-reviewer.service";
import { registrationReviewerRepository } from "./modules/registration-reviewer/registration-reviewer.runtime";
import { StudentRosterService } from "./modules/student-roster/student-roster.service";
import { rosterLookup, studentRosterRepository } from "./modules/student-roster/student-roster.runtime";
import { registrationReviewPolicy } from "./modules/registration-reviewer/registration-reviewer.runtime";
import { PrismaRegistrationReviewRepository } from "./modules/registration-review/registration-review.repository";
import { RegistrationReviewService } from "./modules/registration-review/registration-review.service";
import { PasswordResetService } from "./modules/auth/password-reset.service";
import { PrismaPasswordResetTokenRepository } from "./modules/auth/password-reset-token.repository";
import { PrismaPasswordResetUserRepository } from "./modules/auth/password-reset-user.repository";
import { createThrottleKeyer } from "./shared/throttle-key";
import { AccountDeactivationService } from "./modules/account-deactivation/account-deactivation.service";
import { PrismaAccountDeactivationRepository } from "./modules/account-deactivation/account-deactivation.repository";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const prisma = createPrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const tokens = createTokenService(env.JWT_ACCESS_SECRET);
const actors = new ActorContextService(new PrismaAuthRepository(prisma));
const cookie: CookieConfig = {
  name: "refresh_token",
  path: "/api/v1/auth",
  sameSite: env.REFRESH_COOKIE_SAMESITE,
  secure: env.NODE_ENV === "production" || env.REFRESH_COOKIE_SAMESITE === "none",
};
const sessions = new SessionService({
  repo: new PrismaRefreshTokenRepository(),
  actors,
  tokens,
  runTx: prismaTxRunner(prisma),
  config: DEFAULT_SESSION_CONFIG,
  logger,
});

const login = new LoginService({
  credentials: new PrismaCredentialsRepository(prisma),
  actors,
  sessions,
  tokens,
  throttle: new LoginThrottle(),
  passwords: { verify: verifyPassword, dummyHash: getDummyHash },
  refreshTtlSeconds: DEFAULT_SESSION_CONFIG.refreshTtlSeconds,
  logger,
});
const invitations = new InvitationService({
  repo: new PrismaInvitationRepository(),
  audit: new PrismaAuditRepository(),
  outbox: new PrismaOutboxRepository(),
  appBaseUrl: env.APP_BASE_URL,
  runTx: prismaTxRunner(prisma),
  logger,
});
const studentRegistration = new StudentRegistrationService({
  users: new PrismaStudentRegistrationRepository(),
  tokens: new PrismaEmailVerificationTokenRepository(),
  outbox: new PrismaOutboxRepository(),
  audit: new PrismaAuditRepository(),
  appBaseUrl: env.APP_BASE_URL,
  runTx: prismaTxRunner(prisma),
  verifyAttemptLimit: env.EMAIL_VERIFY_FAILED_ATTEMPT_LIMIT,
  verifyWindowMs: env.EMAIL_VERIFY_WINDOW_MS,
});
const registrationReviewers = new RegistrationReviewerService({
  repo: registrationReviewerRepository,
  audit: new PrismaAuditRepository(),
  runTx: prismaTxRunner(prisma),
});
const studentRoster = new StudentRosterService({
  repo: studentRosterRepository,
  audit: new PrismaAuditRepository(),
  runTx: prismaTxRunner(prisma),
});
const registrationReviews = new RegistrationReviewService({
  repo: new PrismaRegistrationReviewRepository(),
  policy: registrationReviewPolicy,
  roster: rosterLookup,
  rosterRepo: studentRosterRepository,
  audit: new PrismaAuditRepository(),
  outbox: new PrismaOutboxRepository(),
  appBaseUrl: env.APP_BASE_URL,
  runTx: prismaTxRunner(prisma),
});
void getDummyHash().catch((err) => logger.error({ err }, "could not prepare the dummy password hash"));

const passwordReset = new PasswordResetService({
  users: new PrismaPasswordResetUserRepository(prisma),
  tokens: new PrismaPasswordResetTokenRepository(),
  outbox: new PrismaOutboxRepository(),
  audit: new PrismaAuditRepository(),
  sessions,
  appBaseUrl: env.APP_BASE_URL,
  runTx: prismaTxRunner(prisma),
  emailLimitPerHour: env.PASSWORD_RESET_EMAIL_LIMIT_PER_HOUR,
  throttleKeyer: createThrottleKeyer(env.THROTTLE_KEY_SECRET),
});

const accountDeactivation = new AccountDeactivationService({
  repo: new PrismaAccountDeactivationRepository(),
  audit: new PrismaAuditRepository(),
  outbox: new PrismaOutboxRepository(),
  runTx: prismaTxRunner(prisma),
});

const app = createApp({
  logger,
  corsOrigins: parseCorsOrigins(env.CORS_ORIGIN),
  tokens,
  actors,
  sessions,
  cookie,
  login,
  invitations,
  studentRegistration,
  registrationReviewers,
  studentRoster,
  registrationReviews,
  passwordReset,
  accountDeactivation,
  trustProxyHops: env.TRUST_PROXY_HOPS,
});

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "API listening");
});

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref(); // do not hang a deploy
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
