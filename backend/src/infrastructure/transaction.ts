import type { Prisma, PrismaClient } from "@prisma/client";

/** Transaction handle passed explicitly to repositories (Decision #52: explicit `tx`, no AsyncLocalStorage). */
export type Tx = Prisma.TransactionClient;

/** Services own the transaction: they receive a runner and open exactly one per use case. */
export type TxRunner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

/** READ COMMITTED (PostgreSQL default) + conditional writes is the baseline (#52). */
export const prismaTxRunner =
  (db: PrismaClient): TxRunner =>
  (fn) =>
    db.$transaction(fn);
