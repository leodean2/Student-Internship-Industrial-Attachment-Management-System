import type { Tx } from "../../infrastructure/transaction";
import { departmentCodeOf } from "../../shared/registration-number";

export interface StudentRegistrationRepository {
  accountExists(tx: Tx, email: string): Promise<boolean>;
  registrationNumberExists(tx: Tx, registrationNumber: string): Promise<boolean>;
  insertUser(tx: Tx, input: { id: string; email: string; name: string; passwordHash: string }): Promise<void>;
  insertStudentRole(tx: Tx, userId: string): Promise<void>;
  insertStudentProfile(tx: Tx, input: { userId: string; registrationNumber: string }): Promise<void>;
  markEmailVerified(tx: Tx, userId: string): Promise<boolean>;
}

export class PrismaStudentRegistrationRepository implements StudentRegistrationRepository {
  async accountExists(tx: Tx, email: string): Promise<boolean> {
    return (await tx.user.count({ where: { email } })) > 0;
  }

  async registrationNumberExists(tx: Tx, registrationNumber: string): Promise<boolean> {
    return (await tx.studentProfile.count({ where: { registrationNumber } })) > 0;
  }

  async insertUser(
    tx: Tx,
    input: { id: string; email: string; name: string; passwordHash: string },
  ): Promise<void> {
    await tx.user.create({ data: { ...input, status: "PENDING_VERIFICATION" } });
  }

  async insertStudentRole(tx: Tx, userId: string): Promise<void> {
    await tx.userRole.create({ data: { userId, role: "STUDENT" } });
  }

  async insertStudentProfile(
    tx: Tx,
    input: { userId: string; registrationNumber: string },
  ): Promise<void> {
    await tx.studentProfile.create({
      data: { ...input, registrationDepartmentCode: departmentCodeOf(input.registrationNumber) },
    });
  }

  async markEmailVerified(tx: Tx, userId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    const now = rows[0]?.now;
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error("Database clock query returned an invalid timestamp");
    }
    const updated = await tx.user.updateMany({
      where: { id: userId, status: "PENDING_VERIFICATION", emailVerifiedAt: null },
      data: { emailVerifiedAt: now },
    });
    return updated.count === 1;
  }
}
