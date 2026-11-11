import { z } from "zod";
import { buildTokenLink, isHttpUrl, isUtcInstant } from "./email-link";

export const INVITATION_CREATED = "INVITATION_CREATED";
export const ACCEPT_INVITATION_PATH = "/accept-invitation";

/** The raw invitation token is carried only in the acceptance URL. */
export const invitationCreatedPayloadSchema = z
  .object({
    acceptanceUrl: z.string().max(2048).refine(isHttpUrl, "acceptanceUrl must be an http(s) URL"),
    expiresAt: z.string().refine(isUtcInstant, "expiresAt must be a UTC ISO-8601 instant"),
    role: z.string().min(1).max(100),
  })
  .strict();

export type InvitationCreatedPayload = z.infer<typeof invitationCreatedPayloadSchema>;

/** Builds `{APP_BASE_URL}/accept-invitation?token=<encoded raw token>`. */
export function buildAcceptanceUrl(appBaseUrl: string, rawToken: string): string {
  return buildTokenLink(appBaseUrl, ACCEPT_INVITATION_PATH, rawToken);
}

export function buildInvitationCreatedPayload(input: {
  appBaseUrl: string;
  rawToken: string;
  role: string;
  expiresAt: Date;
}): InvitationCreatedPayload {
  return invitationCreatedPayloadSchema.parse({
    acceptanceUrl: buildAcceptanceUrl(input.appBaseUrl, input.rawToken),
    expiresAt: input.expiresAt.toISOString(),
    role: input.role,
  });
}
