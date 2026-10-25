import type { UserRoleName, UserStatus } from "@prisma/client";

/** One Organization Supervisor affiliation = one profile row (Decision #43/#62). */
export interface OrganizationAffiliation {
  readonly profileId: string;
  readonly organizationId: string;
}

/**
 * The single, per-request representation of "who is acting" (Decision #51).
 * Built from CURRENT database state on every authenticated request — never from token claims.
 *
 * Only ACTIVE users with at least one role ever get an ActorContext, so `status` is always
 * "ACTIVE" here; it is kept because the locked #51 shape includes it.
 */
export interface ActorContext {
  readonly userId: string;
  readonly status: UserStatus;
  readonly roles: ReadonlySet<UserRoleName>;
  readonly profileIds: {
    readonly student?: string;
    readonly universitySupervisor?: string;
    readonly admin?: string;
    readonly organizationSupervisor: readonly OrganizationAffiliation[];
  };
}

export const hasRole = (actor: ActorContext, role: UserRoleName): boolean => actor.roles.has(role);

export const hasAnyRole = (actor: ActorContext, roles: readonly UserRoleName[]): boolean =>
  roles.some((r) => actor.roles.has(r));

/**
 * Organization-supervisor authority is always scoped by (user, organization), never by user alone
 * (Decision #62 clarification): affiliation lets a supervisor discover/claim, it never grants
 * blanket access. Policies must look up the affiliation for the SPECIFIC organization involved.
 */
export const findOrganizationAffiliation = (
  actor: ActorContext,
  organizationId: string,
): OrganizationAffiliation | undefined =>
  actor.profileIds.organizationSupervisor.find((a) => a.organizationId === organizationId);
