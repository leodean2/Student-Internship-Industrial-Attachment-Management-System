import { Router } from "express";
import { requireAllowedOrigin } from "../../shared/http/origin-guard";
import { setRefreshCookie } from "./cookies";
import { loginBodySchema } from "./login.schemas";
import type { LoginService } from "./login.service";
import type { CookieConfig } from "./session.config";

export function createLoginRouter(deps: {
  login: LoginService;
  cookie: CookieConfig;
  corsOrigins: readonly string[];
}): Router {
  const router = Router();

  // Same CSRF defence as /refresh and /logout (Decision #55): a missing or foreign Origin is a 403, checked before the body.
  router.post("/login", requireAllowedOrigin(deps.corsOrigins), async (req, res) => {
    const body = loginBodySchema.parse(req.body); // a bad body is a 400 and costs no login attempt
    const result = await deps.login.login({ email: body.email, password: body.password, ip: req.ip ?? "unknown" });
    setRefreshCookie(res, deps.cookie, result.refreshToken, result.refreshMaxAgeSeconds);
    res.set("Cache-Control", "no-store").json({
      accessToken: result.accessToken,
      tokenType: "Bearer",
      expiresIn: result.accessExpiresInSeconds,
    });
  });

  return router;
}
