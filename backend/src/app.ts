import cors from "cors";
import express, { type Express, Router } from "express";
import helmet from "helmet";
import type { Logger } from "./infrastructure/logger";
import { createAuthenticate } from "./modules/auth/auth.middleware";
import { createAuthRouter } from "./modules/auth/auth.routes";
import type { ActorContextService } from "./modules/auth/actor-context.service";
import { createLoginRouter } from "./modules/auth/login.routes";
import type { LoginService } from "./modules/auth/login.service";
import { createInvitationRouter } from "./modules/invitations/invitation.routes";
import type { InvitationService } from "./modules/invitations/invitation.service";
import { createStudentRegistrationRouter } from "./modules/student-registration/student-registration.routes";
import type { StudentRegistrationService } from "./modules/student-registration/student-registration.service";
import { createRegistrationReviewerRouter } from "./modules/registration-reviewer/registration-reviewer.routes";
import type { RegistrationReviewerService } from "./modules/registration-reviewer/registration-reviewer.service";
import { createStudentRosterRouter } from "./modules/student-roster/student-roster.routes";
import type { StudentRosterService } from "./modules/student-roster/student-roster.service";
import { createRegistrationReviewRouter } from "./modules/registration-review/registration-review.routes";
import type { RegistrationReviewService } from "./modules/registration-review/registration-review.service";
import { createStudentProfileRouter } from "./modules/student-profile/student-profile.routes";
import type { StudentProfileService } from "./modules/student-profile/student-profile.service";
import { createAccountDeactivationRouter } from "./modules/account-deactivation/account-deactivation.routes";
import type { AccountDeactivationService } from "./modules/account-deactivation/account-deactivation.service";
import { createPasswordResetRouter } from "./modules/auth/password-reset.routes";
import type { PasswordResetService } from "./modules/auth/password-reset.service";
import { createSessionRouter } from "./modules/auth/session.routes";
import type { CookieConfig } from "./modules/auth/session.config";
import type { SessionService } from "./modules/auth/session.service";
import type { TokenService } from "./modules/auth/token";
import { errorHandler, notFoundHandler } from "./shared/http/error-handler";
import { requestContext, requestLogger } from "./shared/http/request-context";

export interface AppDeps {
  logger: Logger;
  /** Strict browser-origin allow-list (Decision #55). */
  corsOrigins: string[];
  tokens: TokenService;
  actors: ActorContextService;
  sessions: SessionService;
  cookie: CookieConfig;
  /** Always passed by server.ts. Optional so HTTP tests that never log in need no change. */
  login?: LoginService;
  /** Admin invitations. Optional so unrelated HTTP tests need no database-backed service. */
  invitations?: InvitationService;
  /** Public student registration and email verification. Optional so unrelated app tests remain isolated. */
  studentRegistration?: StudentRegistrationService;
  /** Admin management of department-scoped registration reviewers. */
  registrationReviewers?: RegistrationReviewerService;
  /** Admin-only student roster CSV import and history. */
  studentRoster?: StudentRosterService;
  /** Reviewer-assignment-scoped student registration review actions. */
  registrationReviews?: RegistrationReviewService;
  /** Student profile completion (C1-F). */
  studentProfile?: StudentProfileService;
  /** Password reset (C2). */
  passwordReset?: PasswordResetService;
  /** Account deactivation (C3). */
  accountDeactivation?: AccountDeactivationService;
  /** Reverse proxies in front of the API (Render: 1). 0 = ignore X-Forwarded-For. See TRUST_PROXY_HOPS. */
  trustProxyHops?: number;
}

/**
 * The API process (#49). Dependencies are injected so tests can run the real HTTP stack
 * without a database. Order matters: correlation id first so even rejected requests are traceable.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.trustProxyHops ?? 0);

  app.use(requestContext(deps.logger));
  app.use(requestLogger());
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) => callback(null, origin !== undefined && deps.corsOrigins.includes(origin)),
      credentials: true, // needed later for the httpOnly refresh cookie (#51/#55)
    }),
  );
  app.use(express.json({ limit: "100kb" }));

  const authenticate = createAuthenticate({ tokens: deps.tokens, actors: deps.actors });

  const api = Router();
  api.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  api.use("/auth", createAuthRouter(authenticate));
  api.use("/auth", createSessionRouter({ sessions: deps.sessions, cookie: deps.cookie, corsOrigins: deps.corsOrigins }));
  if (deps.login) {
    api.use("/auth", createLoginRouter({ login: deps.login, cookie: deps.cookie, corsOrigins: deps.corsOrigins }));
  }
  if (deps.studentRegistration) {
    api.use("/auth", createStudentRegistrationRouter(deps.studentRegistration, deps.corsOrigins));
  }
  if (deps.invitations) {
    api.use(
      "/invitations",
      createInvitationRouter({ invitations: deps.invitations, authenticate, corsOrigins: deps.corsOrigins }),
    );
  }
  if (deps.registrationReviewers) {
    api.use(
      "/admin/registration-reviewers",
      createRegistrationReviewerRouter(deps.registrationReviewers, authenticate),
    );
  }
  if (deps.studentRoster) {
    api.use("/admin/student-roster", createStudentRosterRouter(deps.studentRoster, authenticate));
  }
  if (deps.registrationReviews) {
    api.use("/registration-reviews", createRegistrationReviewRouter(deps.registrationReviews, authenticate));
  }
  if (deps.studentProfile) {
    api.use("/students/me", createStudentProfileRouter(deps.studentProfile, authenticate));
  }
  if (deps.passwordReset) {
    api.use("/auth", createPasswordResetRouter({ passwordReset: deps.passwordReset, corsOrigins: deps.corsOrigins }));
  }
  if (deps.accountDeactivation) {
    api.use("/admin/users", createAccountDeactivationRouter(deps.accountDeactivation, authenticate));
  }
  app.use("/api/v1", api); // #55: version prefix only, no versioning scheme

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
