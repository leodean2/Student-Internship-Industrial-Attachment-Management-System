import type { Tx } from "../../infrastructure/transaction";

export interface ReviewerAssignment {
  id: string;
  userId: string;
  departmentCode: string;
  grantedByUserId: string;
  grantedAt: Date;
  revokedAt: Date | null;
  revokedByUserId: string | null;
}

export interface GrantTarget {
  status: string;
  roles: string[];
}

export interface RegistrationReviewerRepository {
  findGrantTarget(tx: Tx, userId: string): Promise<GrantTarget | null>;
  insert(
    tx: Tx,
    input: { id: string; userId: string; departmentCode: string; grantedByUserId: string },
  ): Promise<ReviewerAssignment>;
  findById(tx: Tx, id: string): Promise<ReviewerAssignment | null>;
  revoke(tx: Tx, id: string, revokedByUserId: string): Promise<boolean>;
  list(
    tx: Tx,
    query: { userId?: string; departmentCode?: string; active?: boolean; limit: number; cursor?: string },
  ): Promise<ReviewerAssignment[]>;
  lockActiveDepartments(tx: Tx, userId: string): Promise<string[]>;
}

export class PrismaRegistrationReviewerRepository implements RegistrationReviewerRepository {
  async findGrantTarget(tx: Tx, userId: string): Promise<GrantTarget | null> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { status: true, roles: { select: { role: true } } },
    });
    return user ? { status: user.status, roles: user.roles.map(({ role }) => role) } : null;
  }

  async insert(
    tx: Tx,
    input: { id: string; userId: string; departmentCode: string; grantedByUserId: string },
  ): Promise<ReviewerAssignment> {
    return tx.registrationReviewer.create({ data: input });
  }

  async findById(tx: Tx, id: string): Promise<ReviewerAssignment | null> {
    return tx.registrationReviewer.findUnique({ where: { id } });
  }

  async revoke(tx: Tx, id: string, revokedByUserId: string): Promise<boolean> {
    const updated = await tx.$executeRaw`
      UPDATE registration_reviewers
      SET "revokedAt" = clock_timestamp(), "revokedByUserId" = ${revokedByUserId}
      WHERE id = ${id} AND "revokedAt" IS NULL`;
    return updated === 1;
  }

  async list(
    tx: Tx,
    query: { userId?: string; departmentCode?: string; active?: boolean; limit: number; cursor?: string },
  ): Promise<ReviewerAssignment[]> {
    return tx.registrationReviewer.findMany({
      where: {
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.departmentCode ? { departmentCode: query.departmentCode } : {}),
        ...(query.active === true ? { revokedAt: null } : {}),
        ...(query.active === false ? { revokedAt: { not: null } } : {}),
      },
      orderBy: [{ grantedAt: "desc" }, { id: "desc" }],
      take: query.limit,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
  }

  async lockActiveDepartments(tx: Tx, userId: string): Promise<string[]> {
    const rows = await tx.$queryRaw<{ departmentCode: string }[]>`
      SELECT "departmentCode" FROM registration_reviewers
      WHERE "userId" = ${userId} AND "revokedAt" IS NULL
      FOR SHARE`;
    return rows.map(({ departmentCode }) => departmentCode);
  }
}
