import { Router } from "express";
import { requireAllowedOrigin } from "../../shared/http/origin-guard";
import { clientIp } from "../../shared/client-ip";
import { registerStudentSchema, verifyEmailSchema } from "./student-registration.validation";
import type { StudentRegistrationService } from "./student-registration.service";

export function createStudentRegistrationRouter(
  service: StudentRegistrationService,
  corsOrigins: readonly string[],
): Router {
  const router = Router();
  const allowedOrigin = requireAllowedOrigin(corsOrigins);

  router.post("/register", allowedOrigin, async (req, res) => {
    const input = registerStudentSchema.parse(req.body);
    const result = await service.register(input, { ip: clientIp(req) });
    res.set("Cache-Control", "no-store").status(202).json(result);
  });

  router.post("/verify-email", allowedOrigin, async (req, res) => {
    const input = verifyEmailSchema.parse(req.body);
    await service.verifyEmail(input, { ip: clientIp(req) });
    res.set("Cache-Control", "no-store").status(200).json({ status: "email_verified" });
  });

  return router;
}
