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
void getDummyHash().catch((err) => logger.error({ err }, "could not prepare the dummy password hash"));

const app = createApp({
  logger,
  corsOrigins: parseCorsOrigins(env.CORS_ORIGIN),
  tokens,
  actors,
  sessions,
  cookie,
  login,
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
