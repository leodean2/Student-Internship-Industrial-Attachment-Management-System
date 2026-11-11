import type { Prisma } from "@prisma/client";
import type { Tx } from "../../infrastructure/transaction";

export type RegistrationStatusName = "PENDING" | "CONFIRMED" | "REJECTED";

export interface ReviewProfile {
  id: string;
  userId: string;
  name: string;
  email: string;
  emailVerifiedAt: Date | null;
  userStatus: string;
  userCreatedAt: Date;
  registrationNumber: string | null;
  rejectedRegistrationNumber: string | null;
  registrationDepartmentCode: string;
  registrationStatus: RegistrationStatusName;
  registrationDecidedAt: Date | null;
  registrationDecidedByUserId: string | null;
  registrationDecisionBasis: string | null;
  registrationDecisionReason: string | null;
}

export interface HistoryEntry {
  action: string;
  actorUserId: string;
  occurredAt: Date;
}

export interface ReviewListQuery {
  departments: readonly string[];
  status: RegistrationStatusName;
  emailVerified?: boolean;
  registrationNumber?: string;
  limit: number;
  cursor?: string;
}

export interface RegistrationReviewRepository {
  findById(tx: Tx, id: string): Promise<ReviewProfile | null>;
  lockById(tx: Tx, id: string): Promise<ReviewProfile | null>;
  list(tx: Tx, query: ReviewListQuery): Promise<ReviewProfile[]>;
  history(tx: Tx, profile: Pick<ReviewProfile, "id" | "userId">): Promise<HistoryEntry[]>;
  markConfirmed(
    tx: Tx,
    input: { profileId: string; registrationNumber: string; reviewerId: string; basis: string },
  ): Promise<Date | null>;
  markRejected(
    tx: Tx,
    input: { profileId: string; claimedNumber: string; reviewerId: string; reason: string },
  ): Promise<Date | null>;
  applyCorrection(
    tx: Tx,
    input: {
      profileId: string;
      expectedStatus: "PENDING" | "REJECTED";
      registrationNumber: string;
      departmentCode: string;
    },
  ): Promise<boolean>;
  activateUser(tx: Tx, userId: string): Promise<boolean>;
}

const profileInclude = {
  user: { select: { name: true, email: true, emailVerifiedAt: true, status: true, createdAt: true } },
} as const;
type Row = Prisma.StudentProfileGetPayload<{ include: typeof profileInclude }>;

function toReviewProfile(row: Row): ReviewProfile {
  return {
    id: row.id,
    userId: row.userId,
    name: row.user.name,
    email: row.user.email,
    emailVerifiedAt: row.user.emailVerifiedAt,
    userStatus: row.user.status,
    userCreatedAt: row.user.createdAt,
    registrationNumber: row.registrationNumber,
    rejectedRegistrationNumber: row.rejectedRegistrationNumber,
    registrationDepartmentCode: row.registrationDepartmentCode,
    registrationStatus: row.registrationStatus,
    registrationDecidedAt: row.registrationDecidedAt,
    registrationDecidedByUserId: row.registrationDecidedByUserId,
    registrationDecisionBasis: row.registrationDecisionBasis,
    registrationDecisionReason: row.registrationDecisionReason,
  };
}

async function databaseNow(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Database clock query returned an invalid timestamp");
  }
  return now;
}

export class PrismaRegistrationReviewRepository implements RegistrationReviewRepository {
  async findById(tx: Tx, id: string): Promise<ReviewProfile | null> {
    const row = await tx.studentProfile.findUnique({ where: { id }, include: profileInclude });
    return row ? toReviewProfile(row) : null;
  }

  async lockById(tx: Tx, id: string): Promise<ReviewProfile | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM student_profiles WHERE id = ${id} FOR UPDATE`;
    return locked.length === 0 ? null : this.findById(tx, id);
  }

  async list(tx: Tx, query: ReviewListQuery): Promise<ReviewProfile[]> {
    const where: Prisma.StudentProfileWhereInput = {
      registrationDepartmentCode: { in: [...query.departments] },
      registrationStatus: query.status,
      ...(query.emailVerified === undefined
        ? {}
        : { user: { emailVerifiedAt: query.emailVerified ? { not: null } : null } }),
      ...(query.registrationNumber
        ? {
            OR: [
              { registrationNumber: query.registrationNumber },
              { rejectedRegistrationNumber: query.registrationNumber },
            ],
          }
        : {}),
    };
    const rows = await tx.studentProfile.findMany({
      where,
      include: profileInclude,
      orderBy: [{ user: { createdAt: "asc" } }, { id: "asc" }],
      take: query.limit,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    return rows.map(toReviewProfile);
  }

  async history(tx: Tx, profile: Pick<ReviewProfile, "id" | "userId">): Promise<HistoryEntry[]> {
    return tx.auditLog.findMany({
      where: {
        OR: [
          { targetType: "StudentProfile", targetId: profile.id },
          {
            targetType: "User",
            targetId: profile.userId,
            action: { in: ["STUDENT_REGISTERED", "EMAIL_VERIFIED"] },
          },
        ],
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      select: { action: true, actorUserId: true, occurredAt: true },
    });
  }

  async markConfirmed(
    tx: Tx,
    input: { profileId: string; registrationNumber: string; reviewerId: string; basis: string },
  ): Promise<Date | null> {
    const now = await databaseNow(tx);
    const updated = await tx.studentProfile.updateMany({
      where: {
        id: input.profileId,
        registrationStatus: "PENDING",
        registrationNumber: input.registrationNumber,
      },
      data: {
        registrationStatus: "CONFIRMED",
        registrationDecidedAt: now,
        registrationDecidedByUserId: input.reviewerId,
        registrationDecisionBasis: input.basis,
        registrationDecisionReason: null,
        rejectedRegistrationNumber: null,
      },
    });
    return updated.count === 1 ? now : null;
  }

  async markRejected(
    tx: Tx,
    input: { profileId: string; claimedNumber: string; reviewerId: string; reason: string },
  ): Promise<Date | null> {
    const now = await databaseNow(tx);
    const updated = await tx.studentProfile.updateMany({
      where: { id: input.profileId, registrationStatus: "PENDING", registrationNumber: input.claimedNumber },
      data: {
        registrationStatus: "REJECTED",
        registrationNumber: null,
        rejectedRegistrationNumber: input.claimedNumber,
        registrationDecidedAt: now,
        registrationDecidedByUserId: input.reviewerId,
        registrationDecisionReason: input.reason,
        registrationDecisionBasis: null,
      },
    });
    return updated.count === 1 ? now : null;
  }

  async applyCorrection(
    tx: Tx,
    input: {
      profileId: string;
      expectedStatus: "PENDING" | "REJECTED";
      registrationNumber: string;
      departmentCode: string;
    },
  ): Promise<boolean> {
    const updated = await tx.studentProfile.updateMany({
      where: { id: input.profileId, registrationStatus: input.expectedStatus },
      data: {
        registrationNumber: input.registrationNumber,
        registrationDepartmentCode: input.departmentCode,
        registrationStatus: "PENDING",
        rejectedRegistrationNumber: null,
        registrationDecidedAt: null,
        registrationDecidedByUserId: null,
        registrationDecisionBasis: null,
        registrationDecisionReason: null,
      },
    });
    return updated.count === 1;
  }

  async activateUser(tx: Tx, userId: string): Promise<boolean> {
    const updated = await tx.user.updateMany({
      where: { id: userId, status: "PENDING_VERIFICATION", emailVerifiedAt: { not: null } },
      data: { status: "ACTIVE" },
    });
    return updated.count === 1;
  }
}
