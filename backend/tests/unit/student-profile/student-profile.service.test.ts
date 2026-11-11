import { describe, expect, it } from "vitest";
import type { Tx, TxRunner } from "../../../src/infrastructure/transaction";
import type { ActorContext } from "../../../src/modules/auth/actor-context";
import type { EditableProfileData, StudentProfileRecord, StudentProfileRepository } from "../../../src/modules/student-profile/student-profile.repository";
import { StudentProfileService } from "../../../src/modules/student-profile/student-profile.service";
import { createUpdateStudentProfileSchema } from "../../../src/modules/student-profile/student-profile.validation";

const NOW = new Date("2026-11-10T10:00:00.000Z");
const schema = createUpdateStudentProfileSchema(() => NOW);
const parse = (value: unknown) => schema.parse(value);

const actorOf = (userId: string, studentProfileId?: string) =>
  ({
    userId,
    status: "ACTIVE",
    roles: new Set(["STUDENT"]),
    profileIds: { student: studentProfileId, organizationSupervisor: [] },
  }) as unknown as ActorContext;

function baseRecord(overrides: Partial<StudentProfileRecord> = {}): StudentProfileRecord {
  return {
    id: "p1", userId: "u1", name: "Student One", email: "s1@example.test",
    registrationNumber: "CIT-221-001/2024", registrationStatus: "CONFIRMED",
    university: null, faculty: null, department: null, course: null,
    yearOfStudy: null, phone: null, expectedGraduation: null,
    ...overrides,
  };
}

function build(record: StudentProfileRecord = baseRecord()) {
  const world = { record, audit: [] as Record<string, unknown>[], writes: [] as EditableProfileData[] };
  const runTx: TxRunner = async (fn) => fn(undefined as unknown as Tx);
  const repo: StudentProfileRepository = {
    findById: async (_tx, id) => (id === world.record.id ? { ...world.record } : null),
    update: async (_tx, _id, data) => {
      world.writes.push(data);
      Object.assign(world.record, data);
    },
  };
  const service = new StudentProfileService({
    repo,
    audit: { record: async (_tx: Tx, entry: Record<string, unknown>) => { world.audit.push(entry); } } as never,
    runTx,
  });
  return { service, world };
}

const ALL_SEVEN = {
  university: "Example University", faculty: "Computing", department: "Information Technology",
  course: "BSc Information Technology", yearOfStudy: 3, phone: "0712 345 678", expectedGraduation: "2027-06-30",
};

describe("StudentProfileService.get", () => {
  it("returns read-only registration data and a server-computed isComplete", async () => {
    const { service } = build();
    expect(await service.get(actorOf("u1", "p1"))).toMatchObject({
      registration: { name: "Student One", email: "s1@example.test", registrationNumber: "CIT-221-001/2024", status: "CONFIRMED" },
      university: null,
      isComplete: false,
    });
  });
});

describe("StudentProfileService.update", () => {
  it("completes the profile when all seven fields are set, and un-completes it when one is cleared", async () => {
    const { service } = build();
    const done = await service.update(actorOf("u1", "p1"), parse(ALL_SEVEN));
    expect(done).toMatchObject({ phone: "+254712345678", expectedGraduation: "2027-06-30", yearOfStudy: 3, isComplete: true });
    const cleared = await service.update(actorOf("u1", "p1"), parse({ phone: null }));
    expect(cleared).toMatchObject({ phone: null, isComplete: false });
  });

  it("writes only the fields that changed, leaves registration data alone, and audits field names only", async () => {
    const { service, world } = build(baseRecord({ university: "Example University", yearOfStudy: 3 }));
    await service.update(actorOf("u1", "p1"), parse({ university: "Example University", yearOfStudy: 4, phone: "0712345678" }));
    expect(world.writes).toEqual([{ yearOfStudy: 4, phone: "+254712345678" }]);
    expect(world.record).toMatchObject({ registrationNumber: "CIT-221-001/2024", registrationStatus: "CONFIRMED", name: "Student One" });
    expect(world.audit).toEqual([
      {
        actorUserId: "u1", action: "STUDENT_PROFILE_UPDATED", targetType: "StudentProfile", targetId: "p1",
        metadata: { fields: ["phone", "yearOfStudy"] },
      },
    ]);
    const audit = JSON.stringify(world.audit);
    for (const secret of ["254712345678", "Example University", "0712"]) expect(audit).not.toContain(secret);
  });

  it("does nothing, and audits nothing, when no value changes", async () => {
    const { service, world } = build(baseRecord({ yearOfStudy: 3 }));
    await service.update(actorOf("u1", "p1"), parse({ yearOfStudy: 3 }));
    expect(world.writes).toHaveLength(0);
    expect(world.audit).toHaveLength(0);
  });

  it("only ever touches the caller's own profile", async () => {
    const { service, world } = build();
    await expect(service.update(actorOf("u1"), parse({ phone: "0712345678" }))).rejects.toThrow(/not found/i);
    await expect(service.update(actorOf("u2", "p1"), parse({ phone: "0712345678" }))).rejects.toThrow();
    expect(world.writes).toHaveLength(0);
  });

  it("refuses a profile that is not confirmed", async () => {
    for (const registrationStatus of ["PENDING", "REJECTED"] as const) {
      const { service, world } = build(baseRecord({ registrationStatus }));
      await expect(service.update(actorOf("u1", "p1"), parse({ phone: "0712345678" }))).rejects.toThrow();
      expect(world.writes).toHaveLength(0);
    }
  });
});
