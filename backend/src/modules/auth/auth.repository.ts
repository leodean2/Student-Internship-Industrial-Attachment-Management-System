import type { PrismaClient, UserRoleName, UserStatus } from "@prisma/client";

/** Plain data the ActorContext is built from. Kept independent of Prisma's types so services are testable with fakes. */
export interface ActorRecord {
  id: string;
  status: UserStatus;
  roles: UserRoleName[];
  studentProfileId: string | null;
  universitySupervisorProfileId: string | null;
  adminProfileId: string | null;
  organizationSupervisorProfiles: { id: string; organizationId: string }[];
}

export interface AuthRepository {
  /** Returns null when no such user exists. Contains NO authorization decisions (#50). */
  findActorRecordById(userId: string): Promise<ActorRecord | null>;
}

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly db: PrismaClient) {}

  async findActorRecordById(userId: string): Promise<ActorRecord | null> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        status: true,
        roles: { select: { role: true } },
        studentProfile: { select: { id: true } },
        universitySupervisorProfile: { select: { id: true } },
        adminProfile: { select: { id: true } },
        organizationSupervisorProfiles: { select: { id: true, organizationId: true } },
      },
    });
    if (!user) return null;
    return {
      id: user.id,
      status: user.status,
      roles: user.roles.map((r) => r.role),
      studentProfileId: user.studentProfile?.id ?? null,
      universitySupervisorProfileId: user.universitySupervisorProfile?.id ?? null,
      adminProfileId: user.adminProfile?.id ?? null,
      organizationSupervisorProfiles: user.organizationSupervisorProfiles,
    };
  }
}
