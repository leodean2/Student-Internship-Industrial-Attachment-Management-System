import { Router, type RequestHandler } from "express";
import { requireRole } from "../auth/auth.middleware";
import type { StudentProfileService } from "./student-profile.service";
import { createUpdateStudentProfileSchema } from "./student-profile.validation";

const updateSchema = createUpdateStudentProfileSchema();

/** Mount at /students/me. `authenticate` requires an ACTIVE account, then `requireRole("STUDENT")`. */
export function createStudentProfileRouter(service: StudentProfileService, authenticate: RequestHandler): Router {
  const router = Router();
  router.use(authenticate, requireRole("STUDENT"));

  router.get("/profile", async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await service.get(req.actor!));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/profile", async (req, res, next) => {
    try {
      const input = updateSchema.parse(req.body);
      res.setHeader("Cache-Control", "no-store");
      res.json(await service.update(req.actor!, input));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
