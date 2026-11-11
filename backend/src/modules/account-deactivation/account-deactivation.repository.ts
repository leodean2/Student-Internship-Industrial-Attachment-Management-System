import type { Tx } from "../../infrastructure/transaction";

export interface DeactivationTarget {
  userId: string;
  email: string;
  status: "PENDING_VERIFICATION" | "ACTIVE" | "DEACTIVATED";
  roles: string[];
}

export interface AccountDeactivationRepository {
  /**
   * Loads the target user's current status and roles inside the transaction,
   * locking the row for update to prevent concurrent deactivations.
   */
  findAndLockTarget(tx: Tx, userId: string): Promise<DeactivationTarget | null>;

  /**
   * Conditionally sets status to DEACTIVATED only when the row is still in `expectedStatus`.
   * Returns true when exactly one row was updated (the conditional write succeeded).
   */
  deactivate(tx: Tx, userId: string, expectedStatus: "PENDING_VERIFICATION" | "ACTIVE"): Promise<boolean>;

  /**
   * Revokes all active reviewer assignments for a university supervisor.
   * Returns the count of revoked assignments.
   */
  revokeReviewerAssignments(tx: Tx, userId: string, revokedByUserId: string): Promise<number>;
}

export class PrismaAccountDeactivationRepository implements AccountDeactivationRepository {
  async findAndLockTarget(tx: Tx, userId: string): Promise<DeactivationTarget | null> {
    // Lock the user row first (FOR UPDATE on a simple PK lookup is allowed).
    const userRows = await tx.$queryRaw<{ id: string; email: string; status: string }[]>`
      SELECT id, email, status FROM users WHERE id = ${userId} FOR UPDATE`;
    const user = userRows[0];
    if (!user) return null;

    // Fetch roles separately (no aggregation on the locked row).
    const roleRows = await tx.$queryRaw<{ role: string }[]>`
      SELECT role FROM user_roles WHERE "userId" = ${userId} ORDER BY role`;

    return {
      userId: user.id,
      email: user.email,
      status: user.status as DeactivationTarget["status"],
      roles: roleRows.map(({ role }) => role),
    };
  }

  async deactivate(tx: Tx, userId: string, expectedStatus: "PENDING_VERIFICATION" | "ACTIVE"): Promise<boolean> {
    const updated = await tx.$executeRaw`
      UPDATE users
      SET status = 'DEACTIVATED'::"UserStatus", "updatedAt" = clock_timestamp()
      WHERE id = ${userId} AND status = ${expectedStatus}::"UserStatus"`;
    return updated === 1;
  }

  async revokeReviewerAssignments(tx: Tx, userId: string, revokedByUserId: string): Promise<number> {
    return tx.$executeRaw`
      UPDATE registration_reviewers
      SET "revokedAt" = clock_timestamp(), "revokedByUserId" = ${revokedByUserId}
      WHERE "userId" = ${userId} AND "revokedAt" IS NULL`;
  }
}
