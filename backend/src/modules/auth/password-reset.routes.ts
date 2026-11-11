import { Router } from "express";
import { requireAllowedOrigin } from "../../shared/http/origin-guard";
import { clientIp } from "../../shared/client-ip";
import { requestPasswordResetBodySchema, confirmPasswordResetBodySchema } from "./password-reset.schemas";
import type { PasswordResetService } from "./password-reset.service";

export function createPasswordResetRouter(deps: {
  passwordReset: PasswordResetService;
  corsOrigins: readonly string[];
}): Router {
  const router = Router();
  const allowedOrigin = requireAllowedOrigin(deps.corsOrigins);

  /**
   * POST /auth/request-password-reset
   * Always returns 202 with the same generic message (C2 §2 — no account enumeration).
   */
  router.post("/request-password-reset", allowedOrigin, async (req, res) => {
    const body = requestPasswordResetBodySchema.parse(req.body);
    const result = await deps.passwordReset.requestReset(body.email, { ip: clientIp(req) });
    res.set("Cache-Control", "no-store").status(202).json(result);
  });

  /**
   * POST /auth/confirm-password-reset
   * Returns 204 on success. Returns 404 for an invalid/expired/consumed token (C2 §3).
   */
  router.post("/confirm-password-reset", allowedOrigin, async (req, res) => {
    const body = confirmPasswordResetBodySchema.parse(req.body);
    await deps.passwordReset.confirmReset({ token: body.token, newPassword: body.newPassword }, { ip: clientIp(req) });
    res.set("Cache-Control", "no-store").status(204).send();
  });

  return router;
}
