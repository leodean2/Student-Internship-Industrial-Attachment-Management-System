import type { PrismaClient } from "@prisma/client";
import type { CredentialRecord } from "./login.service";

/** Data access only. No authorization decisions (#50). Email is stored lower-cased by the application. */
export interface CredentialsRepository {
  findByEmail(email: string): Promise<CredentialRecord | null>;
}

export class PrismaCredentialsRepository implements CredentialsRepository {
  private readonly db: PrismaClient;

  constructor(db: PrismaClient) {
    this.db = db;
  }

  async findByEmail(email: string): Promise<CredentialRecord | null> {
    const user = await this.db.user.findUnique({ where: { email }, select: { id: true, passwordHash: true } });
    return user ? { userId: user.id, passwordHash: user.passwordHash } : null;
  }
}
