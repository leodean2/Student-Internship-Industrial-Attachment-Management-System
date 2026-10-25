import { PrismaClient, type Prisma } from "@prisma/client";

/**
 * Single place the Prisma client is constructed. Services and repositories receive
 * it by injection; nothing else calls `new PrismaClient()`.
 */
export function createPrismaClient(options?: Prisma.PrismaClientOptions): PrismaClient {
  return new PrismaClient(options);
}

export type { PrismaClient };
