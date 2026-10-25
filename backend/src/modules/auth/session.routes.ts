import { Router } from "express";
import { AppError } from "../../shared/errors";
import { requireAllowedOrigin } from "../../shared/http/origin-guard";
import { clearRefreshCookie, readCookie, setRefreshCookie } from "./cookies";
import type { CookieConfig } from "./session.config";
import type { SessionService } from "./session.service";
import { Errors } from "../../shared/errors";

export function createSessionRouter(deps: {
  sessions: SessionService;
  cookie: CookieConfig;
  corsOrigins: readonly string[];
}): Router {
  const { sessions, cookie } = deps;
  const router = Router();
  const originGuard = requireAllowedOrigin(deps.corsOrigins);

  // POST-only (Decision #55). A GET falls through to the 404 handler.
  router.post("/refresh", originGuard, async (req, res) => {
    const presented = readCookie(req, cookie.name);
    if (!presented) throw Errors.unauthenticated();
    try {
      const result = await sessions.refresh(presented);
      setRefreshCookie(res, cookie, result.refreshToken, result.refreshMaxAgeSeconds);
      res.set("Cache-Control", "no-store").json({
        accessToken: result.accessToken,
        tokenType: "Bearer",
        expiresIn: result.accessExpiresInSeconds,
      });
    } catch (err) {
      // A dead token should stop being sent. But NOT on 409: the winning request's new cookie may already be
      // in the browser, and clearing here would delete it.
      if (err instanceof AppError && err.status === 401) clearRefreshCookie(res, cookie);
      throw err;
    }
  });

  router.post("/logout", originGuard, async (req, res) => {
    await sessions.logout(readCookie(req, cookie.name));
    clearRefreshCookie(res, cookie);
    res.set("Cache-Control", "no-store").status(204).end();
  });

  return router;
}
