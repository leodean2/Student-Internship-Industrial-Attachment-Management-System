import type { Prisma } from "@prisma/client";
import type { Tx } from "../../infrastructure/transaction";
import { toUtcDate } from "../../infrastructure/db-clock";
import { INVITABLE_ROLE, INVITATION_VALIDITY_DAYS, type InvitableRole } from "./invitation.types";

export type BlockingInvitation = "ACCEPTED" | "PENDING";
export type InvitationStatus = "ACCEPTED" | "CANCELLED" | "EXPIRED" | "PENDING";

export interface InvitationForAcceptance {
  id: string;
  email: string;
  role: InvitableRole;
}

export interface InvitationLifecycle {
  status: InvitationStatus;
}

export interface InvitationListRecord {
  id: string;
  email: string;
  role: string;
  organizationId: string | null;
  invitedByUserId: string;
  acceptedByUserId: string | null;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

export type InvitationDetailRecord = InvitationListRecord;

export interface InvitationRepository {
  accountExists(tx: Tx, email: string): Promise<boolean>;
  findBlocking(tx: Tx, email: string): Promise<BlockingInvitation | null>;
  findByTokenHash(tx: Tx, tokenHash: string): Promise<InvitationForAcceptance | null>;
  findEmailById(tx: Tx, invitationId: string): Promise<string | null>;
  findLifecycleForUpdate(tx: Tx, invitationId: string): Promise<InvitationLifecycle | null>;
  insertUser(tx: Tx, data: { id: string; email: string; passwordHash: string; name: string }): Promise<void>;
  insertRole(tx: Tx, data: { id: string; userId: string; role: InvitableRole }): Promise<void>;
  insertUniversitySupervisorProfile(
    tx: Tx,
    data: { id: string; userId: string; staffId: string | null; title: string | null },
  ): Promise<void>;
  claim(tx: Tx, data: { invitationId: string; tokenHash: string; userId: string }): Promise<boolean>;
  cancel(tx: Tx, invitationId: string): Promise<Date | null>;
  findMany(
    tx: Tx,
    where: Prisma.InvitationWhereInput,
    skip: number,
    take: number,
  ): Promise<InvitationListRecord[]>;
  count(tx: Tx, where: Prisma.InvitationWhereInput): Promise<number>;
  findAdminById(tx: Tx, invitationId: string): Promise<InvitationDetailRecord | null>;
  insert(
    tx: Tx,
    data: { id: string; email: string; role: InvitableRole; invitedByUserId: string; tokenHash: string },
  ): Promise<{ createdAt: Date; expiresAt: Date }>;
}

export class PrismaInvitationRepository implements InvitationRepository {
  async accountExists(tx: Tx, email: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ one: number }[]>`SELECT 1 AS one FROM users WHERE email = ${email} LIMIT 1`;
    return rows.length > 0;
  }

  async findBlocking(tx: Tx, email: string): Promise<BlockingInvitation | null> {
    const rows = await tx.$queryRaw<{ state: BlockingInvitation }[]>`
      SELECT CASE WHEN "acceptedByUserId" IS NOT NULL THEN 'ACCEPTED' ELSE 'PENDING' END AS state
      FROM invitations
      WHERE email = ${email}
        AND ("acceptedByUserId" IS NOT NULL
             OR ("revokedAt" IS NULL AND "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')))
      ORDER BY ("acceptedByUserId" IS NOT NULL) DESC
      LIMIT 1`;
    return rows[0]?.state ?? null;
  }

  async findByTokenHash(tx: Tx, tokenHash: string): Promise<InvitationForAcceptance | null> {
    const rows = await tx.$queryRaw<InvitationForAcceptance[]>`
      SELECT id, email, role::text AS role
      FROM invitations
      WHERE "tokenHash" = ${tokenHash}
        AND role = ${INVITABLE_ROLE}::"UserRoleName"
      LIMIT 1`;
    return rows[0] ?? null;
  }

  async findEmailById(tx: Tx, invitationId: string): Promise<string | null> {
    const invitation = await tx.invitation.findUnique({
      where: { id: invitationId },
      select: { email: true },
    });
    return invitation?.email ?? null;
  }

  async findLifecycleForUpdate(tx: Tx, invitationId: string): Promise<InvitationLifecycle | null> {
    const rows = await tx.$queryRaw<InvitationLifecycle[]>`
      WITH db_clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now)
      SELECT CASE
               WHEN i."acceptedByUserId" IS NOT NULL THEN 'ACCEPTED'
               WHEN i."revokedAt" IS NOT NULL THEN 'CANCELLED'
               WHEN i."expiresAt" <= db_clock.now THEN 'EXPIRED'
               ELSE 'PENDING'
             END AS status
      FROM invitations i
      CROSS JOIN db_clock
      WHERE i.id = ${invitationId}
      FOR UPDATE OF i`;
    return rows[0] ?? null;
  }

  async insertUser(
    tx: Tx,
    data: { id: string; email: string; passwordHash: string; name: string },
  ): Promise<void> {
    await tx.$executeRaw`
      WITH t AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now)
      INSERT INTO users ("id", email, "passwordHash", name, status, "createdAt", "updatedAt")
      SELECT ${data.id}, ${data.email}, ${data.passwordHash}, ${data.name}, 'ACTIVE'::"UserStatus", t.now, t.now
      FROM t`;
  }

  async insertRole(tx: Tx, data: { id: string; userId: string; role: InvitableRole }): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO user_roles ("id", "userId", role)
      VALUES (${data.id}, ${data.userId}, ${data.role}::"UserRoleName")`;
  }

  async insertUniversitySupervisorProfile(
    tx: Tx,
    data: { id: string; userId: string; staffId: string | null; title: string | null },
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO university_supervisor_profiles ("id", "userId", "staffId", title)
      VALUES (${data.id}, ${data.userId}, ${data.staffId}, ${data.title})`;
  }

  async claim(tx: Tx, data: { invitationId: string; tokenHash: string; userId: string }): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE invitations
      SET "acceptedByUserId" = ${data.userId},
          "acceptedAt" = clock_timestamp() AT TIME ZONE 'UTC'
      WHERE id = ${data.invitationId}
        AND "tokenHash" = ${data.tokenHash}
        AND "acceptedByUserId" IS NULL
        AND "revokedAt" IS NULL
        AND "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
      RETURNING id`;
    return rows.length > 0;
  }

  async cancel(tx: Tx, invitationId: string): Promise<Date | null> {
    const rows = await tx.$queryRaw<{ revokedAt: Date | string }[]>`
      UPDATE invitations
      SET "revokedAt" = clock_timestamp() AT TIME ZONE 'UTC'
      WHERE id = ${invitationId}
        AND "acceptedByUserId" IS NULL
        AND "revokedAt" IS NULL
        AND "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
      RETURNING "revokedAt"`;
    return rows[0] ? toUtcDate(rows[0].revokedAt) : null;
  }

  async findMany(
    tx: Tx,
    where: Prisma.InvitationWhereInput,
    skip: number,
    take: number,
  ): Promise<InvitationListRecord[]> {
    return tx.invitation.findMany({
      where,
      skip,
      take,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        email: true,
        role: true,
        organizationId: true,
        invitedByUserId: true,
        acceptedByUserId: true,
        createdAt: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
      },
    });
  }

  async count(tx: Tx, where: Prisma.InvitationWhereInput): Promise<number> {
    return tx.invitation.count({ where });
  }

  async findAdminById(tx: Tx, invitationId: string): Promise<InvitationDetailRecord | null> {
    return tx.invitation.findUnique({
      where: { id: invitationId },
      select: {
        id: true,
        email: true,
        role: true,
        organizationId: true,
        invitedByUserId: true,
        acceptedByUserId: true,
        createdAt: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
      },
    });
  }

  async insert(
    tx: Tx,
    data: { id: string; email: string; role: InvitableRole; invitedByUserId: string; tokenHash: string },
  ): Promise<{ createdAt: Date; expiresAt: Date }> {
    const rows = await tx.$queryRaw<{ createdAt: Date | string; expiresAt: Date | string }[]>`
      WITH t AS (SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now)
      INSERT INTO invitations ("id", "email", "role", "invitedByUserId", "tokenHash", "createdAt", "expiresAt")
      SELECT ${data.id}, ${data.email}, ${data.role}::"UserRoleName", ${data.invitedByUserId}, ${data.tokenHash},
             t.now, t.now + make_interval(days => ${INVITATION_VALIDITY_DAYS}::int)
      FROM t
      RETURNING "createdAt", "expiresAt"`;
    const row = rows[0];
    if (!row) throw new Error("Invitation insert returned no row.");
    return { createdAt: toUtcDate(row.createdAt), expiresAt: toUtcDate(row.expiresAt) };
  }
}
