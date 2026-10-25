import { Errors } from "../../shared/errors";
import type { ActorContext } from "./actor-context";
import type { AuthRepository } from "./auth.repository";

export class ActorContextService {
  constructor(private readonly repo: AuthRepository) {}

  /**
   * Builds the ActorContext from current database state (Decision #51).
   *
   * Rejections:
   *  - unknown user            -> UNAUTHENTICATED (indistinguishable from a bad token)
   *  - status != ACTIVE        -> ACCOUNT_INACTIVE (deactivated, or never verified)
   *  - user with NO roles      -> UNAUTHENTICATED. Every real user holds >= 1 role (#62), so this
   *                               rejects the seeded SYSTEM sentinel structurally (#69) without
   *                               hard-coding its id, and without revealing that it exists.
   */
  async load(userId: string): Promise<ActorContext> {
    const record = await this.repo.findActorRecordById(userId);
    if (!record) throw Errors.unauthenticated();
    if (record.status !== "ACTIVE") throw Errors.accountInactive();
    if (record.roles.length === 0) throw Errors.unauthenticated();

    return {
      userId: record.id,
      status: record.status,
      roles: new Set(record.roles),
      profileIds: {
        student: record.studentProfileId ?? undefined,
        universitySupervisor: record.universitySupervisorProfileId ?? undefined,
        admin: record.adminProfileId ?? undefined,
        organizationSupervisor: record.organizationSupervisorProfiles.map((p) => ({
          profileId: p.id,
          organizationId: p.organizationId,
        })),
      },
    };
  }
}
