import { Router, type RequestHandler } from "express";
import { requireRole } from "../auth/auth.middleware";
import { requireAllowedOrigin } from "../../shared/http/origin-guard";
import {
  acceptInvitationBodySchema,
  createInvitationBodySchema,
  invitationIdParamsSchema,
  invitationListQuerySchema,
} from "./invitation.validation";
import type { InvitationService } from "./invitation.service";

export function createInvitationRouter(deps: {
  invitations: InvitationService;
  authenticate: RequestHandler;
  corsOrigins: readonly string[];
}): Router {
  const router = Router();

  router.post("/accept", requireAllowedOrigin(deps.corsOrigins), async (req, res) => {
    const body = acceptInvitationBodySchema.parse(req.body);
    const accepted = await deps.invitations.accept({ ...body, ip: req.ip ?? "unknown" });
    res.status(201).set("Cache-Control", "no-store").json(accepted);
  });

  router.post("/", deps.authenticate, requireRole("ADMIN"), async (req, res) => {
    const body = createInvitationBodySchema.parse(req.body);
    const created = await deps.invitations.create(req.actor!, body);
    res.status(201).json({
      invitationId: created.invitationId,
      email: created.email,
      role: created.role,
      expiresAt: created.expiresAt.toISOString(),
    });
  });

  router.get("/", deps.authenticate, requireRole("ADMIN"), async (req, res) => {
    const query = invitationListQuerySchema.parse(req.query);
    const page = await deps.invitations.list(req.actor!, query);
    res.set("Cache-Control", "no-store").json(page);
  });

  router.patch("/:id/cancel", deps.authenticate, requireRole("ADMIN"), async (req, res) => {
    const { id } = invitationIdParamsSchema.parse(req.params);
    const result = await deps.invitations.cancel(req.actor!, id);
    res.set("Cache-Control", "no-store").json(result);
  });

  router.get("/:id", deps.authenticate, requireRole("ADMIN"), async (req, res) => {
    const { id } = invitationIdParamsSchema.parse(req.params);
    const invitation = await deps.invitations.get(req.actor!, id);
    res.set("Cache-Control", "no-store").json(invitation);
  });

  return router;
}
