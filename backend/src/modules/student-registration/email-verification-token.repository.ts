import type { Tx } from "../../infrastructure/transaction";

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface EmailVerificationTokenRepository {
  insert(tx: Tx, input: { userId: string; tokenHash: string }): Promise<{ expiresAt: Date }>;
  consume(tx: Tx, tokenHash: string): Promise<{ userId: string } | null>;
}

async function databaseNow(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Database clock query returned an invalid timestamp");
  }
  return now;
}

export class PrismaEmailVerificationTokenRepository implements EmailVerificationTokenRepository {
  async insert(tx: Tx, input: { userId: string; tokenHash: string }): Promise<{ expiresAt: Date }> {
    const expiresAt = new Date((await databaseNow(tx)).getTime() + EMAIL_VERIFICATION_TTL_MS);
    await tx.emailVerificationToken.create({
      data: { userId: input.userId, tokenHash: input.tokenHash, expiresAt },
    });
    return { expiresAt };
  }

  async consume(tx: Tx, tokenHash: string): Promise<{ userId: string } | null> {
    const now = await databaseNow(tx);
    const claimed = await tx.emailVerificationToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return null;

    const row = await tx.emailVerificationToken.findUnique({
      where: { tokenHash },
      select: { userId: true },
    });
    return row ? { userId: row.userId } : null;
  }
}
