import { Router, type RequestHandler } from "express";
import { requireRole } from "../auth/auth.middleware";
import { deactivateAccountParamsSchema } from "./account-deactivation.schemas";
import type { AccountDeactivationService } from "./account-deactivation.service";

export function createAccountDeactivationRouter(
  service: AccountDeactivationService,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate, requireRole("ADMIN"));

  /**
   * POST /admin/users/:userId/deactivate
   * 204 on success. 403 for self/ADMIN-on-ADMIN. 404 for unknown user. 409 if already deactivated.
   */
  router.post("/:userId/deactivate", async (req, res, next) => {
    try {
      const { userId } = deactivateAccountParamsSchema.parse(req.params);
      await service.deactivate(req.actor!, userId);
      res.set("Cache-Control", "no-store").status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
