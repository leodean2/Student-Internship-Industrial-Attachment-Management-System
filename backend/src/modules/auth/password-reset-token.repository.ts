import type { Tx } from "../../infrastructure/transaction";

/** One hour — matches the amendment (C2 §3). Reference: EMAIL_VERIFICATION_TTL_MS is 24 h. */
export const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export interface PasswordResetTokenRepository {
  /**
   * Inserts a new token for the user and invalidates (marks usedAt) any previous unused tokens for the same user
   * in the same operation, so only one outstanding reset token exists per user at a time.
   */
  insert(tx: Tx, input: { userId: string; tokenHash: string }): Promise<{ expiresAt: Date }>;
  /**
   * Atomically marks the token as consumed (sets usedAt). Returns the userId when successful, null when the
   * token is unknown, already used, or expired. Database time is used for the expiry check.
   */
  consume(tx: Tx, tokenHash: string): Promise<{ userId: string } | null>;
  /** Invalidates all unused, unexpired reset tokens for a user (called after a successful reset). */
  invalidateAllForUser(tx: Tx, userId: string): Promise<void>;
}

async function databaseNow(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Database clock query returned an invalid timestamp");
  }
  return now;
}

export class PrismaPasswordResetTokenRepository implements PasswordResetTokenRepository {
  async insert(tx: Tx, input: { userId: string; tokenHash: string }): Promise<{ expiresAt: Date }> {
    const now = await databaseNow(tx);
    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS);

    // Invalidate any previous unused tokens so only one is outstanding at a time.
    await tx.passwordResetToken.updateMany({
      where: { userId: input.userId, usedAt: null },
      data: { usedAt: now },
    });

    await tx.passwordResetToken.create({
      data: { userId: input.userId, tokenHash: input.tokenHash, expiresAt },
    });
    return { expiresAt };
  }

  async consume(tx: Tx, tokenHash: string): Promise<{ userId: string } | null> {
    const now = await databaseNow(tx);

    // Atomic single-use guard: only an unused, unexpired row matches.
    const claimed = await tx.passwordResetToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return null;

    const row = await tx.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { userId: true },
    });
    return row ? { userId: row.userId } : null;
  }

  async invalidateAllForUser(tx: Tx, userId: string): Promise<void> {
    const now = await databaseNow(tx);
    await tx.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    });
  }
}
