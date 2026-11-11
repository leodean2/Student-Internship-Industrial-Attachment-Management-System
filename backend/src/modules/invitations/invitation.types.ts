export const INVITABLE_ROLE = "UNIVERSITY_SUPERVISOR" as const;
export type InvitableRole = typeof INVITABLE_ROLE;

export const INVITATION_VALIDITY_DAYS = 7;

export type InvitationStatus = "PENDING" | "ACCEPTED" | "EXPIRED" | "CANCELLED";

export interface CreatedInvitation {
  invitationId: string;
  email: string;
  role: InvitableRole;
  expiresAt: Date;
}
