import type { PrismaClient } from "@prisma/client";
import type { Tx } from "../../infrastructure/transaction";
import type { PasswordResetUserRecord, PasswordResetUserRepository } from "./password-reset.service";

export class PrismaPasswordResetUserRepository implements PasswordResetUserRepository {
  constructor(private readonly db: PrismaClient) {}

  async findByEmail(email: string): Promise<PasswordResetUserRecord | null> {
    const row = await this.db.user.findUnique({
      where: { email },
      select: { id: true, email: true, status: true },
    });
    if (!row) return null;
    return { userId: row.id, email: row.email, status: row.status };
  }

  async findById(tx: Tx, userId: string): Promise<PasswordResetUserRecord | null> {
    const row = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, status: true },
    });
    if (!row) return null;
    return { userId: row.id, email: row.email, status: row.status };
  }

  async updatePassword(tx: Tx, userId: string, passwordHash: string): Promise<void> {
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
  }
}
