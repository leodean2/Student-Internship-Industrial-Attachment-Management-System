import type { Tx } from "../../infrastructure/transaction";

export interface RosterEntryRecord {
  id: string;
  registrationNumber: string;
  departmentCode: string;
  studentName: string | null;
  rosterStatus: string | null;
  importId: string;
}

export interface RosterEntryWithImport extends RosterEntryRecord {
  importedAt: Date;
}

export interface RosterImportRecord {
  id: string;
  importedByUserId: string;
  importedAt: Date;
  fileSha256: string;
  rowCount: number;
  insertedCount: number;
  skippedCount: number;
  conflictCount: number;
  invalidCount: number;
  duplicateCount: number;
}

export interface NewRosterEntry {
  registrationNumber: string;
  departmentCode: string;
  studentName: string | null;
  rosterStatus: string | null;
}

export interface StudentRosterRepository {
  findEntriesByNumbers(tx: Tx, numbers: readonly string[]): Promise<RosterEntryRecord[]>;
  findEntryByNumber(tx: Tx, registrationNumber: string): Promise<RosterEntryWithImport | null>;
  createImport(tx: Tx, data: Omit<RosterImportRecord, "id" | "importedAt">): Promise<RosterImportRecord>;
  insertEntries(tx: Tx, importId: string, entries: readonly NewRosterEntry[]): Promise<number>;
  listImports(tx: Tx, query: { limit: number; cursor?: string }): Promise<RosterImportRecord[]>;
  findImport(tx: Tx, id: string): Promise<RosterImportRecord | null>;
}

const CHUNK_SIZE = 1000;

function chunks<T>(items: readonly T[], size = CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class PrismaStudentRosterRepository implements StudentRosterRepository {
  async findEntriesByNumbers(tx: Tx, numbers: readonly string[]): Promise<RosterEntryRecord[]> {
    const found: RosterEntryRecord[] = [];
    for (const chunk of chunks(numbers)) {
      found.push(...(await tx.studentRosterEntry.findMany({ where: { registrationNumber: { in: chunk } } })));
    }
    return found;
  }

  async findEntryByNumber(tx: Tx, registrationNumber: string): Promise<RosterEntryWithImport | null> {
    const entry = await tx.studentRosterEntry.findUnique({
      where: { registrationNumber },
      include: { firstImport: { select: { importedAt: true } } },
    });
    if (!entry) return null;
    const { firstImport, ...rest } = entry;
    return { ...rest, importedAt: firstImport.importedAt };
  }

  async createImport(tx: Tx, data: Omit<RosterImportRecord, "id" | "importedAt">): Promise<RosterImportRecord> {
    return tx.studentRosterImport.create({ data });
  }

  async insertEntries(tx: Tx, importId: string, entries: readonly NewRosterEntry[]): Promise<number> {
    let inserted = 0;
    for (const chunk of chunks(entries)) {
      const result = await tx.studentRosterEntry.createMany({ data: chunk.map((entry) => ({ ...entry, importId })) });
      inserted += result.count;
    }
    return inserted;
  }

  async listImports(tx: Tx, query: { limit: number; cursor?: string }): Promise<RosterImportRecord[]> {
    return tx.studentRosterImport.findMany({
      orderBy: [{ importedAt: "desc" }, { id: "desc" }],
      take: query.limit,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
  }

  async findImport(tx: Tx, id: string): Promise<RosterImportRecord | null> {
    return tx.studentRosterImport.findUnique({ where: { id } });
  }
}
