import { describe, expect, it } from "vitest";
import type { Tx, TxRunner } from "../../src/infrastructure/transaction";
import type { ActorContext } from "../../src/modules/auth/actor-context";
import { RosterLookup } from "../../src/modules/student-roster/roster-lookup";
import type {
  NewRosterEntry,
  RosterEntryRecord,
  RosterImportRecord,
  StudentRosterRepository,
} from "../../src/modules/student-roster/student-roster.repository";
import { StudentRosterService } from "../../src/modules/student-roster/student-roster.service";

const actorOf = (...roles: string[]) =>
  ({ userId: "admin-1", status: "ACTIVE", roles: new Set(roles), profileIds: { organizationSupervisor: [] } }) as unknown as ActorContext;
const admin = actorOf("ADMIN");
const HEADER = "registration_number,student_name,student_status";
const rows = (...lines: string[]) => [HEADER, ...lines].join("\n");

function build(options: { failAudit?: boolean } = {}) {
  const world = {
    entries: [] as RosterEntryRecord[],
    imports: [] as RosterImportRecord[],
    audit: [] as Record<string, unknown>[],
    locks: [] as string[],
    listLimits: [] as number[],
  };
  const runTx: TxRunner = async (fn) => {
    const snapshot = structuredClone(world);
    try {
      return await fn(undefined as unknown as Tx);
    } catch (error) {
      Object.assign(world, snapshot);
      throw error;
    }
  };
  const repo: StudentRosterRepository = {
    findEntriesByNumbers: async (_tx, numbers) =>
      world.entries.filter((entry) => numbers.includes(entry.registrationNumber)),
    findEntryByNumber: async (_tx, registrationNumber) => {
      const entry = world.entries.find((candidate) => candidate.registrationNumber === registrationNumber);
      return entry ? { ...entry, importedAt: new Date("2026-11-09T00:00:00Z") } : null;
    },
    createImport: async (_tx, data) => {
      const record = { ...data, id: `import-${world.imports.length + 1}`, importedAt: new Date() };
      world.imports.push(record);
      return record;
    },
    insertEntries: async (_tx, importId, entries: readonly NewRosterEntry[]) => {
      for (const entry of entries) {
        world.entries.push({ ...entry, id: `entry-${world.entries.length + 1}`, importId });
      }
      return entries.length;
    },
    listImports: async (_tx, query) => {
      world.listLimits.push(query.limit);
      return world.imports.slice(0, query.limit);
    },
    findImport: async (_tx, id) => world.imports.find((record) => record.id === id) ?? null,
  };
  const audit = {
    record: async (_tx: Tx, entry: Record<string, unknown>) => {
      world.audit.push(entry);
      if (options.failAudit) throw new Error("audit down");
    },
  };
  const service = new StudentRosterService({
    repo,
    audit: audit as never,
    runTx,
    acquireLock: async (_tx, key) => {
      world.locks.push(key);
    },
  });
  return { service, world, repo };
}

describe("StudentRosterService.importCsv", () => {
  const csv = rows(
    "CIT-221-001/2024,A,ACTIVE",
    "CIT-221-002/2024,B,ACTIVE",
    "bad,C,ACTIVE",
    "CIT-221-004/2024,D,WITHDRAWN",
  );

  it("dry-run reports counts and writes nothing", async () => {
    const { service, world } = build();
    const report = await service.importCsv(admin, csv, { dryRun: true });
    expect(report).toMatchObject({
      dryRun: true,
      importId: null,
      counts: { rows: 4, inserted: 3, skipped: 0, conflicts: 0, invalid: 1, duplicates: 0 },
    });

    expect(world.entries).toHaveLength(0);
    expect(world.imports).toHaveLength(0);
    expect(world.audit).toHaveLength(0);
    expect(world.locks).toHaveLength(0);
  });

  it("commits entries, history and count-only audit in one transaction", async () => {
    const { service, world } = build();
    const report = await service.importCsv(admin, csv, { dryRun: false });
    expect(report.importId).toBe("import-1");
    expect(world.entries.map((entry) => entry.registrationNumber)).toEqual([
      "CIT-221-001/2024",
      "CIT-221-002/2024",
      "CIT-221-004/2024",
    ]);
    expect(world.imports[0]).toMatchObject({
      importedByUserId: "admin-1",
      rowCount: 4,
      insertedCount: 3,
      invalidCount: 1,
      skippedCount: 0,
      conflictCount: 0,
      duplicateCount: 0,
    });
    expect(world.locks).toEqual(["student-roster-import"]);
    expect(world.audit).toHaveLength(1);
    expect(world.audit[0]).toMatchObject({
      actorUserId: "admin-1",
      action: "STUDENT_ROSTER_IMPORTED",
      targetType: "StudentRosterImport",
      targetId: "import-1",
    });
    const metadata = JSON.stringify(world.audit[0]!.metadata);
    expect(metadata).not.toContain("CIT-221");
    expect(metadata).not.toContain("STUDENT");
    expect(report.invalid).toEqual([{ row: 3, reason: "invalid_registration_number" }]);
  });

  it("re-importing identical records is idempotent", async () => {
    const { service, world } = build();
    await service.importCsv(admin, csv, { dryRun: false });
    const second = await service.importCsv(admin, csv, { dryRun: false });
    expect(second.counts).toMatchObject({ inserted: 0, skipped: 3, conflicts: 0 });
    expect(world.entries).toHaveLength(3);
  });

  it("reports differing rows as field-name-only conflicts and never overwrites", async () => {
    const { service, world } = build();
    await service.importCsv(admin, rows("CIT-221-001/2024,Original,ACTIVE"), { dryRun: false });
    const report = await service.importCsv(
      admin,
      rows("CIT-221-001/2024,Changed,WITHDRAWN", "CIT-221-002/2024,New,ACTIVE"),
      { dryRun: false },
    );
    expect(report.counts).toMatchObject({ inserted: 1, skipped: 0, conflicts: 1 });
    expect(report.conflicts).toEqual([{ row: 1, fields: ["student_name", "student_status"] }]);
    expect(JSON.stringify(report.conflicts)).not.toContain("Changed");
    expect(world.entries.find((entry) => entry.registrationNumber === "CIT-221-001/2024")).toMatchObject({
      studentName: "Original",
      rosterStatus: "ACTIVE",
    });
  });

  it("accounts for every row in the report", async () => {
    const { service } = build();
    await service.importCsv(admin, rows("CIT-221-001/2024,A,ACTIVE"), { dryRun: false });
    const report = await service.importCsv(
      admin,
      rows(
        "CIT-221-001/2024,A,ACTIVE",
        "CIT-221-002/2024,B,ACTIVE",
        "CIT-221-003/2024,C,ACTIVE",
        "CIT-221-003/2024,C,ACTIVE",
        "bad,D,ACTIVE",
        "CIT-221-001/2024,Z,ACTIVE",
      ),
      { dryRun: true },
    );
    const { rows: total, inserted, skipped, conflicts, invalid, duplicates } = report.counts;
    expect(total).toBe(inserted + skipped + conflicts + invalid + duplicates);
  });

  it("leaves nothing behind if the audit write fails", async () => {
    const { service, world } = build({ failAudit: true });
    await expect(service.importCsv(admin, csv, { dryRun: false })).rejects.toThrow("audit down");
    expect(world.entries).toHaveLength(0);
    expect(world.imports).toHaveLength(0);
  });

  it("is ADMIN-only and reports malformed file errors as validation failures", async () => {
    const { service } = build();
    await expect(service.importCsv(actorOf("UNIVERSITY_SUPERVISOR"), csv, { dryRun: true })).rejects.toThrow();
    await expect(service.importCsv(admin, "student_name\nA\n", { dryRun: true })).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      details: [{ path: "file", message: expect.stringContaining("Missing required column") }],
    });
  });

  it("truncates details but preserves full counts", async () => {
    const { service } = build();
    const many = Array.from({ length: 250 }, (_, index) => `bad-${index},X,ACTIVE`);
    const report = await service.importCsv(admin, rows(...many), { dryRun: true });
    expect(report.counts.invalid).toBe(250);
    expect(report.invalid).toHaveLength(200);
    expect(report.detailsTruncated).toBe(true);
  });
});

describe("StudentRosterService.listImports", () => {
  it("requests one lookahead import for accurate pagination", async () => {
    const { service, world } = build();
    await service.listImports(admin, { limit: 20 });
    expect(world.listLimits).toEqual([21]);
  });
});

describe("RosterLookup", () => {
  it("returns not-found, eligible, and ineligible matches", async () => {
    const { service, repo } = build();
    await service.importCsv(
      admin,
      rows("CIT-221-001/2024,A,ACTIVE", "CIT-221-002/2024,B,WITHDRAWN"),
      { dryRun: false },
    );
    const lookup = new RosterLookup(repo);
    const tx = undefined as unknown as Tx;
    expect(await lookup.match(tx, "CIT-221-001/2024")).toMatchObject({ result: "found", studentName: "A" });
    expect(await lookup.match(tx, "CIT-221-002/2024")).toMatchObject({ result: "found_ineligible" });
    expect(await lookup.match(tx, "CIT-221-999/2024")).toEqual({ result: "not_found" });
  });
});
