import type { Tx } from "./transaction";

export const invitationEmailLockKey = (normalizedEmail: string): string => `invitation-email:${normalizedEmail}`;

/** Acquires a transaction-scoped lock on the caller's transaction connection. */
export async function acquireTransactionLock(tx: Tx, key: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS locked`;
}
