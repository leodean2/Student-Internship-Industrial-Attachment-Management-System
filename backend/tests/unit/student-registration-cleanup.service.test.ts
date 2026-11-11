import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/infrastructure/logger";
import type { Tx, TxRunner } from "../../src/infrastructure/transaction";
import type { StudentRegistrationCleanupRepository } from "../../src/modules/student-registration-cleanup/cleanup.repository";
import { StudentRegistrationCleanupService } from "../../src/modules/student-registration-cleanup/cleanup.service";

const tx = {} as Tx;
const runTx: TxRunner = async (operation) => operation(tx);

function createRepository(
  overrides: Partial<StudentRegistrationCleanupRepository> = {},
): StudentRegistrationCleanupRepository {
  return {
    startJobRun: async () => "job-1",
    findEligibleUserIds: async () => [],
    cleanupEligibleUser: async () => true,
    finishJobRun: async () => undefined,
    ...overrides,
  };
}

describe("StudentRegistrationCleanupService", () => {
  it("previews eligible candidates without starting a job run or deleting users", async () => {
    const calls: string[] = [];
    const service = new StudentRegistrationCleanupService({
      repo: createRepository({
        startJobRun: async () => { calls.push("startJobRun"); return "job-1"; },
        findEligibleUserIds: async () => ["student-1", "student-2"],
        cleanupEligibleUser: async () => { calls.push("cleanupEligibleUser"); return true; },
      }),
      runTx,
      logger: createLogger("silent"),
    });

    await expect(service.preview()).resolves.toEqual({ eligibleCandidates: 2, batchLimit: 100 });
    expect(calls).toEqual([]);
  });

  it("records a successful no-op run", async () => {
    const finished: Parameters<StudentRegistrationCleanupRepository["finishJobRun"]>[2][] = [];
    const service = new StudentRegistrationCleanupService({
      repo: createRepository({
        finishJobRun: async (_tx, _jobRunId, result) => {
          finished.push(result);
        },
      }),
      runTx,
      logger: createLogger("silent"),
    });

    await expect(service.run()).resolves.toMatchObject({
      jobRunId: "job-1",
      itemsProcessed: 0,
      itemsDeleted: 0,
      itemsFailed: 0,
      status: "SUCCESS",
    });
    expect(finished).toEqual([{ itemsProcessed: 0, itemsFailed: 0, status: "SUCCESS" }]);
  });

  it("isolates failed deletions and records partial failure telemetry", async () => {
    const finished: Parameters<StudentRegistrationCleanupRepository["finishJobRun"]>[2][] = [];
    const service = new StudentRegistrationCleanupService({
      repo: createRepository({
        findEligibleUserIds: async () => ["deleted", "blocked"],
        cleanupEligibleUser: async (_tx, userId) => {
          if (userId === "blocked") throw new Error("foreign key blocks deletion");
          return true;
        },
        finishJobRun: async (_tx, _jobRunId, result) => {
          finished.push(result);
        },
      }),
      runTx,
      logger: createLogger("silent"),
    });

    await expect(service.run()).resolves.toMatchObject({
      itemsProcessed: 2,
      itemsDeleted: 1,
      itemsFailed: 1,
      status: "PARTIAL_FAILURE",
    });
    expect(finished).toEqual([{ itemsProcessed: 2, itemsFailed: 1, status: "PARTIAL_FAILURE" }]);
  });

  it("marks the run failed and surfaces candidate-query errors", async () => {
    const finished: Parameters<StudentRegistrationCleanupRepository["finishJobRun"]>[2][] = [];
    const service = new StudentRegistrationCleanupService({
      repo: createRepository({
        findEligibleUserIds: async () => {
          throw new Error("database unavailable");
        },
        finishJobRun: async (_tx, _jobRunId, result) => {
          finished.push(result);
        },
      }),
      runTx,
      logger: createLogger("silent"),
    });

    await expect(service.run()).rejects.toThrow("database unavailable");
    expect(finished).toEqual([{ itemsProcessed: 0, itemsFailed: 0, status: "FAILED" }]);
  });
});
