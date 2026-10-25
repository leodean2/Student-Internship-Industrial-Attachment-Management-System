import type { PrismaClient } from "@prisma/client";
import type { Tx } from "../../infrastructure/transaction";

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  /** Absolute session deadline (Decision #77); identical for every token in a rotation chain. */
  sessionExpiresAt: Date;
  /** Set when the token was rotated OR explicitly revoked. For a rotated token this is the rotation time. */
  revokedAt: Date | null;
  /** Set only by rotation. Revoked-but-not-replaced means logout / deactivation / password reset. */
  replacedById: string | null;
}

/**
 * Data access only — no authorization or policy decisions (#50). Every method takes the
 * transaction handle explicitly (#52). Tokens are addressed by their SHA-256 hash; the raw token never reaches the database.
 */
export interface RefreshTokenRepository {
  /**
   * The single time source for every session decision (Decision #76): the DATABASE clock, fixed for the
   * duration of the transaction. Rotation times are written with it and the reuse grace window is measured
   * against it, so API instances with skewed clocks cannot disagree about whether a token is "recently rotated".
   */
  now(tx: Tx): Promise<Date>;
  findByHash(tx: Tx, tokenHash: string): Promise<RefreshTokenRecord | null>;
  create(tx: Tx, data: { userId: string; tokenHash: string; expiresAt: Date; sessionExpiresAt: Date }): Promise<{ id: string }>;
  /**
   * The atomic single-use guard. Marks `oldId` as rotated to `newId` ONLY IF it is still unrevoked and unexpired.
   * Returns false when no row matched (already consumed, revoked or expired) — i.e. the caller lost the race.
   */
  markRotated(tx: Tx, oldId: string, newId: string, now: Date): Promise<boolean>;
  /** Revokes one token (logout). Returns false if it was already revoked. */
  revoke(tx: Tx, id: string, now: Date): Promise<boolean>;
  revokeAllForUser(tx: Tx, userId: string, now: Date): Promise<number>;
  /** Revokes `startId` and every token after it in the rotation chain. */
  revokeChainFrom(tx: Tx, startId: string, now: Date): Promise<number>;
}

export class PrismaRefreshTokenRepository implements RefreshTokenRepository {
  async now(tx: Tx): Promise<Date> {
    // PostgreSQL now() is the transaction's start time: stable for the whole use case.
    const rows = await tx.$queryRaw<{ now: Date | string }[]>`SELECT now() AS now`;
    return new Date(rows[0]!.now);
  }

  async findByHash(tx: Tx, tokenHash: string) {
    return tx.refreshToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true, sessionExpiresAt: true, revokedAt: true, replacedById: true },
    });
  }

  async create(tx: Tx, data: { userId: string; tokenHash: string; expiresAt: Date; sessionExpiresAt: Date }) {
    return tx.refreshToken.create({ data, select: { id: true } });
  }

  async markRotated(tx: Tx, oldId: string, newId: string, now: Date) {
    // Conditional write (#50/#52): the WHERE clause IS the concurrency guard. Under READ COMMITTED a
    // concurrent rotation of the same row blocks here, then re-evaluates `revokedAt IS NULL` and matches nothing.
    const res = await tx.refreshToken.updateMany({
      where: { id: oldId, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now, replacedById: newId },
    });
    return res.count === 1;
  }

  async revoke(tx: Tx, id: string, now: Date) {
    const res = await tx.refreshToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now } });
    return res.count === 1;
  }

  async revokeAllForUser(tx: Tx, userId: string, now: Date) {
    const res = await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    return res.count;
  }

  async revokeChainFrom(tx: Tx, startId: string, now: Date) {
    // Rotation chains are linear (replacedById is UNIQUE, #71), so a recursive walk is bounded and unambiguous.
    return tx.$executeRaw`
      WITH RECURSIVE chain AS (
        SELECT id, "replacedById" FROM refresh_tokens WHERE id = ${startId}
        UNION ALL
        SELECT t.id, t."replacedById" FROM refresh_tokens t JOIN chain c ON t.id = c."replacedById"
      )
      UPDATE refresh_tokens SET "revokedAt" = ${now}
      WHERE id IN (SELECT id FROM chain) AND "revokedAt" IS NULL`;
  }
}
