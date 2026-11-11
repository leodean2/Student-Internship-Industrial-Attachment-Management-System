import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { RosterImportRecord } from "../../src/modules/student-roster/student-roster.repository";
import type { StudentRosterService } from "../../src/modules/student-roster/student-roster.service";
import { buildTestApp } from "./helpers";

const PATH = "/api/v1/admin/student-roster";

function build() {
  const ctx = buildTestApp();
  const record: RosterImportRecord = {
    id: "c1d20000-0000-4000-8000-000000000001",
    importedByUserId: "adm",
    importedAt: new Date("2026-11-09T10:00:00.000Z"),
    fileSha256: "a".repeat(64),
    rowCount: 2,
    insertedCount: 1,
    skippedCount: 0,
    conflictCount: 0,
    invalidCount: 1,
    duplicateCount: 0,
  };
  const service = {
    importCsv: vi.fn(async (_actor, _text, _options) => ({
      dryRun: true,
      importId: null,
      fileSha256: record.fileSha256,
      counts: { rows: 2, inserted: 1, skipped: 0, conflicts: 0, invalid: 1, duplicates: 0 },
      invalid: [{ row: 2, reason: "invalid_registration_number" }],
      duplicates: [],
      conflicts: [],
      detailsTruncated: false,
    })),
    listImports: vi.fn(async () => [record]),
    getImport: vi.fn(async () => record),
  } as unknown as StudentRosterService;
  const app = createApp({
    logger: ctx.logger,
    corsOrigins: ["https://app.example.test"],
    tokens: ctx.tokens,
    actors: ctx.actors,
    sessions: ctx.sessions,
    cookie: ctx.cookie,
    studentRoster: service,
  });
  const as = (userId: string) => ({ Authorization: `Bearer ${ctx.tokens.sign(userId)}` });
  return { app, as, service, record };
}

describe("admin student-roster routes", () => {
  it("requires authentication and ADMIN role for import and history", async () => {
    const { app, as, service } = build();
    expect((await request(app).post(`${PATH}/imports`).send("csv")).status).toBe(401);
    expect(
      (await request(app).post(`${PATH}/imports`).set(as("stu")).set("Content-Type", "text/csv").send("csv")).status,
    ).toBe(403);
    expect((await request(app).get(`${PATH}/imports`).set(as("stu"))).status).toBe(403);
    expect(service.importCsv).not.toHaveBeenCalled();
  });

  it("accepts CSV, defaults to dry-run, and validates binary or wrong media bodies", async () => {
    const { app, as, service } = build();
    const imported = await request(app)
      .post(`${PATH}/imports`)
      .set(as("adm"))
      .set("Content-Type", "text/csv")
      .send("registration_number\nCIT-221-001/2024");
    expect(imported.status).toBe(200);
    expect(service.importCsv).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "adm" }),
      "registration_number\nCIT-221-001/2024",
      { dryRun: true },
    );

    expect(
      (
        await request(app)
          .post(`${PATH}/imports`)
          .query({ dryRun: "false" })
          .set(as("adm"))
          .set("Content-Type", "text/csv")
          .send("PK\u0000workbook")
      ).status,
    ).toBe(400);
    expect(
      (await request(app).post(`${PATH}/imports`).set(as("adm")).send({ file: "not-csv" })).status,
    ).toBe(400);
  });

  it("returns import summaries without exposing entry-level details", async () => {
    const { app, as, service, record } = build();
    const listed = await request(app).get(`${PATH}/imports?limit=10`).set(as("adm"));
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      items: [
        {
          id: record.id,
          importedByUserId: "adm",
          importedAt: record.importedAt.toISOString(),
          fileSha256: record.fileSha256,
          counts: { rows: 2, inserted: 1, skipped: 0, conflicts: 0, invalid: 1, duplicates: 0 },
        },
      ],
      nextCursor: null,
    });
    expect(service.listImports).toHaveBeenCalledWith(expect.objectContaining({ userId: "adm" }), {
      limit: 10,
    });
    expect(listed.body.nextCursor).toBeNull();
    expect((await request(app).get(`${PATH}/imports/${record.id}`).set(as("adm"))).status).toBe(200);
    expect((await request(app).get(`${PATH}/imports/not-a-uuid`).set(as("adm"))).status).toBe(400);
  });

  it("returns a cursor only when a lookahead import exists", async () => {
    const { app, as, service, record } = build();
    const second = { ...record, id: "c1d20000-0000-4000-8000-000000000002" };
    vi.mocked(service.listImports).mockResolvedValueOnce([record, second]);

    const listed = await request(app).get(`${PATH}/imports?limit=1`).set(as("adm"));
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.nextCursor).toBe(record.id);
  });
});
