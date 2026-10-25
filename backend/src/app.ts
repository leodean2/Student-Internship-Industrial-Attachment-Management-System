import cors from "cors";
import express, { type Express, Router } from "express";
import helmet from "helmet";
import type { Logger } from "./infrastructure/logger";
import { createAuthenticate } from "./modules/auth/auth.middleware";
import { createAuthRouter } from "./modules/auth/auth.routes";
import type { ActorContextService } from "./modules/auth/actor-context.service";
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
}

/**
 * The API process (#49). Dependencies are injected so tests can run the real HTTP stack
 * without a database. Order matters: correlation id first so even rejected requests are traceable.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");

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
  app.use("/api/v1", api); // #55: version prefix only, no versioning scheme

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
