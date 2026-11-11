import { Router, type RequestHandler } from "express";
import { pageOf } from "../../shared/pagination";
import type { RegistrationReviewService } from "./registration-review.service";
import {
  confirmBodySchema,
  correctBodySchema,
  listQuerySchema,
  profileIdSchema,
  rejectBodySchema,
} from "./registration-review.validation";

/** The reviewer policy is assignment-based, so admins without assignments are also denied. */
export function createRegistrationReviewRouter(
  service: RegistrationReviewService,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);

  router.get("/", async (req, res, next) => {
    try {
      const query = listQuerySchema.parse(req.query);
      const rows = await service.list(req.actor!, { ...query, limit: query.limit + 1 });
      const { items, nextCursor } = pageOf(rows, query.limit, (row) => row.profileId);
      res.setHeader("Cache-Control", "no-store");
      res.json({ items, nextCursor });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:profileId", async (req, res, next) => {
    try {
      const detail = await service.get(req.actor!, profileIdSchema.parse(req.params.profileId));
      res.setHeader("Cache-Control", "no-store");
      res.json(detail);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:profileId/confirm", async (req, res, next) => {
    try {
      const outcome = await service.confirm(
        req.actor!,
        profileIdSchema.parse(req.params.profileId),
        confirmBodySchema.parse(req.body),
      );
      res.setHeader("Cache-Control", "no-store");
      res.json(outcome);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:profileId/reject", async (req, res, next) => {
    try {
      const outcome = await service.reject(
        req.actor!,
        profileIdSchema.parse(req.params.profileId),
        rejectBodySchema.parse(req.body),
      );
      res.setHeader("Cache-Control", "no-store");
      res.json(outcome);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:profileId/correct", async (req, res, next) => {
    try {
      const outcome = await service.correct(
        req.actor!,
        profileIdSchema.parse(req.params.profileId),
        correctBodySchema.parse(req.body),
      );
      res.setHeader("Cache-Control", "no-store");
      res.json(outcome);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
