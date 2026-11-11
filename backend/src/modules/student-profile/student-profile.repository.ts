import type { Tx } from "../../infrastructure/transaction";
import type { ProfileFields } from "./student-profile.completeness";

export type RegistrationStatusName = "PENDING" | "CONFIRMED" | "REJECTED";

export interface StudentProfileRecord extends ProfileFields {
  id: string;
  userId: string;
  name: string;
  email: string;
  registrationNumber: string | null;
  registrationStatus: RegistrationStatusName;
}

export type EditableProfileData = Partial<ProfileFields>;

export interface StudentProfileRepository {
  findById(tx: Tx, profileId: string): Promise<StudentProfileRecord | null>;
  /** Writes only the fields present in `data`. */
  update(tx: Tx, profileId: string, data: EditableProfileData): Promise<void>;
}

export class PrismaStudentProfileRepository implements StudentProfileRepository {
  async findById(tx: Tx, profileId: string): Promise<StudentProfileRecord | null> {
    const row = await tx.studentProfile.findUnique({
      where: { id: profileId },
      include: { user: { select: { name: true, email: true } } },
    });
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      name: row.user.name,
      email: row.user.email,
      registrationNumber: row.registrationNumber,
      registrationStatus: row.registrationStatus,
      university: row.university,
      faculty: row.faculty,
      department: row.department,
      course: row.course,
      yearOfStudy: row.yearOfStudy,
      phone: row.phone,
      expectedGraduation: row.expectedGraduation,
    };
  }

  async update(tx: Tx, profileId: string, data: EditableProfileData): Promise<void> {
    await tx.studentProfile.update({ where: { id: profileId }, data });
  }
}
