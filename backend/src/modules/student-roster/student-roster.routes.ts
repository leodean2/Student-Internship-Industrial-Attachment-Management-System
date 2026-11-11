import express, { Router, type RequestHandler } from "express";
import { Errors } from "../../shared/errors";
import { pageOf } from "../../shared/pagination";
import { requireRole } from "../auth/auth.middleware";
import type { RosterImportRecord } from "./student-roster.repository";
import type { StudentRosterService } from "./student-roster.service";
import { importIdSchema, importQuerySchema, listImportsQuerySchema } from "./student-roster.validation";

export const ROSTER_BODY_LIMIT = "5mb";

const toResponse = (record: RosterImportRecord) => ({
  id: record.id,
  importedByUserId: record.importedByUserId,
  importedAt: record.importedAt,
  fileSha256: record.fileSha256,
  counts: {
    rows: record.rowCount,
    inserted: record.insertedCount,
    skipped: record.skippedCount,
    conflicts: record.conflictCount,
    invalid: record.invalidCount,
    duplicates: record.duplicateCount,
  },
});

export function createStudentRosterRouter(service: StudentRosterService, authenticate: RequestHandler): Router {
  const router = Router();
  router.use(authenticate, requireRole("ADMIN"));

  router.post("/imports", express.text({ type: "text/csv", limit: ROSTER_BODY_LIMIT }), async (req, res, next) => {
    try {
      const { dryRun } = importQuerySchema.parse(req.query);
      const body: unknown = req.body;
      if (typeof body !== "string" || body.length === 0) {
        throw Errors.validation([
          { path: "body", message: "Send the roster as text/csv. Export Excel files to CSV first." },
        ]);
      }
      if (body.startsWith("PK") || body.includes("\u0000")) {
        throw Errors.validation([
          { path: "body", message: "That looks like a binary or Excel file. Export it to CSV first." },
        ]);
      }
      const report = await service.importCsv(req.actor!, body, { dryRun });
      res.setHeader("Cache-Control", "no-store");
      res.status(dryRun ? 200 : 201).json(report);
    } catch (error) {
      next(error);
    }
  });

  router.get("/imports", async (req, res, next) => {
    try {
      const query = listImportsQuerySchema.parse(req.query);
      const rows = await service.listImports(req.actor!, query);
      const { items, nextCursor } = pageOf(rows, query.limit, (row) => row.id);
      res.setHeader("Cache-Control", "no-store");
      res.json({ items: items.map(toResponse), nextCursor });
    } catch (error) {
      next(error);
    }
  });

  router.get("/imports/:id", async (req, res, next) => {
    try {
      const record = await service.getImport(req.actor!, importIdSchema.parse(req.params.id));
      res.setHeader("Cache-Control", "no-store");
      res.json(toResponse(record));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
