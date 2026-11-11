import { Router, type RequestHandler } from "express";
import { pageOf } from "../../shared/pagination";
import { requireRole } from "../auth/auth.middleware";
import type { ReviewerAssignment } from "./registration-reviewer.repository";
import type { RegistrationReviewerService } from "./registration-reviewer.service";
import {
  grantReviewerSchema,
  listReviewersQuerySchema,
  reviewerIdSchema,
} from "./registration-reviewer.validation";

const toResponse = (assignment: ReviewerAssignment) => ({
  id: assignment.id,
  userId: assignment.userId,
  departmentCode: assignment.departmentCode,
  grantedByUserId: assignment.grantedByUserId,
  grantedAt: assignment.grantedAt,
  revokedAt: assignment.revokedAt,
});

export function createRegistrationReviewerRouter(
  service: RegistrationReviewerService,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate, requireRole("ADMIN"));

  router.post("/", async (req, res, next) => {
    try {
      const input = grantReviewerSchema.parse(req.body);
      const assignment = await service.grant(req.actor!, input);
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json(toResponse(assignment));
    } catch (error) {
      next(error);
    }
  });

  router.get("/", async (req, res, next) => {
    try {
      const query = listReviewersQuerySchema.parse(req.query);
      const rows = await service.list(req.actor!, query);
      const { items, nextCursor } = pageOf(rows, query.limit, (row) => row.id);
      res.setHeader("Cache-Control", "no-store");
      res.json({ items: items.map(toResponse), nextCursor });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      await service.revoke(req.actor!, reviewerIdSchema.parse(req.params.id));
      res.setHeader("Cache-Control", "no-store");
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
