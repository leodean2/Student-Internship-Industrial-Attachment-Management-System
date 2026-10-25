import { Router, type RequestHandler } from "express";

/**
 * Only route in this slice: a read-only identity probe that proves the authentication path
 * end to end. It returns exactly the ActorContext the rest of the system will see.
 */
export function createAuthRouter(authenticate: RequestHandler): Router {
  const router = Router();

  router.get("/me", authenticate, (req, res) => {
    const actor = req.actor!;
    res.json({
      userId: actor.userId,
      status: actor.status,
      roles: [...actor.roles].sort(),
      profileIds: actor.profileIds,
    });
  });

  return router;
}
