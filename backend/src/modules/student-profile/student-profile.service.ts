import type { ActorContext } from "../auth/actor-context";
import type { AuditRepository } from "../audit/audit.repository";
import type { Tx, TxRunner } from "../../infrastructure/transaction";
import { Errors } from "../../shared/errors";
import { REQUIRED_PROFILE_FIELDS, isProfileComplete } from "./student-profile.completeness";
import type {
  EditableProfileData,
  RegistrationStatusName,
  StudentProfileRecord,
  StudentProfileRepository,
} from "./student-profile.repository";
import type { UpdateStudentProfileInput } from "./student-profile.validation";

export interface StudentProfileView {
  /** Read-only here: set at registration and by the registration review. */
  registration: { name: string; email: string; registrationNumber: string | null; status: RegistrationStatusName };
  university: string | null;
  faculty: string | null;
  department: string | null;
  course: string | null;
  yearOfStudy: number | null;
  phone: string | null;
  /** YYYY-MM-DD. */
  expectedGraduation: string | null;
  /** Computed on the server from the stored values. */
  isComplete: boolean;
}

export interface StudentProfileServiceDeps {
  repo: StudentProfileRepository;
  audit: Pick<AuditRepository, "record">;
  runTx: TxRunner;
}

const NOT_FOUND = "Student profile not found.";

function toView(record: StudentProfileRecord): StudentProfileView {
  return {
    registration: {
      name: record.name,
      email: record.email,
      registrationNumber: record.registrationNumber,
      status: record.registrationStatus,
    },
    university: record.university,
    faculty: record.faculty,
    department: record.department,
    course: record.course,
    yearOfStudy: record.yearOfStudy,
    phone: record.phone,
    expectedGraduation: record.expectedGraduation ? record.expectedGraduation.toISOString().slice(0, 10) : null,
    isComplete: isProfileComplete(record),
  };
}

const sameValue = (a: unknown, b: unknown): boolean =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

export class StudentProfileService {
  constructor(private readonly deps: StudentProfileServiceDeps) {}

  async get(actor: ActorContext): Promise<StudentProfileView> {
    const profileId = this.ownProfileId(actor);
    return this.deps.runTx(async (tx) => toView(await this.loadOwn(tx, actor, profileId)));
  }

  /**
   * The target is always the caller's own profile, taken from the actor context: the client never names a profile.
   * Only the seven profile fields can change. Completion is recomputed from what was stored.
   */
  async update(actor: ActorContext, input: UpdateStudentProfileInput): Promise<StudentProfileView> {
    const profileId = this.ownProfileId(actor);
    const { repo, audit, runTx } = this.deps;
    return runTx(async (tx) => {
      const record = await this.loadOwn(tx, actor, profileId);

      const changes: Record<string, unknown> = {};
      const changedFields: string[] = [];
      for (const field of REQUIRED_PROFILE_FIELDS) {
        const next = input[field];
        if (next === undefined) continue; // omitted: unchanged
        if (!sameValue(next, record[field])) {
          changes[field] = next;
          changedFields.push(field);
        }
      }
      if (changedFields.length === 0) return toView(record); // nothing to write, nothing to audit

      await repo.update(tx, profileId, changes as EditableProfileData);
      await audit.record(tx, {
        actorUserId: actor.userId,
        action: "STUDENT_PROFILE_UPDATED",
        targetType: "StudentProfile",
        targetId: profileId,
        // Field names only: values (including the phone number) never enter the audit log.
        metadata: { fields: [...changedFields].sort() },
      });
      return toView({ ...record, ...(changes as EditableProfileData) });
    });
  }

  private ownProfileId(actor: ActorContext): string {
    const profileId = actor.profileIds.student;
    if (!profileId) throw Errors.notFound(NOT_FOUND);
    return profileId;
  }

  private async loadOwn(tx: Tx, actor: ActorContext, profileId: string): Promise<StudentProfileRecord> {
    const record = await this.deps.repo.findById(tx, profileId);
    if (!record) throw Errors.notFound(NOT_FOUND);
    // Defense in depth: an active student always has a confirmed profile, and the profile is always their own.
    if (record.userId !== actor.userId || record.registrationStatus !== "CONFIRMED") throw Errors.forbidden();
    return record;
  }
}
