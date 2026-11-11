import type { Logger } from "pino";
import type { TxRunner } from "../../infrastructure/transaction";
import {
  CLEANUP_BATCH_SIZE,
  type CleanupRunStatus,
  type StudentRegistrationCleanupRepository,
} from "./cleanup.repository";

export interface StudentRegistrationCleanupResult {
  jobRunId: string;
  itemsProcessed: number;
  itemsDeleted: number;
  itemsFailed: number;
  status: CleanupRunStatus;
}

export interface StudentRegistrationCleanupPreview {
  eligibleCandidates: number;
  batchLimit: number;
}

function finalStatus(itemsProcessed: number, itemsFailed: number): CleanupRunStatus {
  if (itemsFailed === 0) return "SUCCESS";
  return itemsFailed === itemsProcessed ? "FAILED" : "PARTIAL_FAILURE";
}

export class StudentRegistrationCleanupService {
  constructor(
    private readonly deps: {
      repo: StudentRegistrationCleanupRepository;
      runTx: TxRunner;
      logger: Logger;
    },
  ) {}

  async preview(): Promise<StudentRegistrationCleanupPreview> {
    const userIds = await this.deps.runTx((tx) =>
      this.deps.repo.findEligibleUserIds(tx, CLEANUP_BATCH_SIZE),
    );
    const result = { eligibleCandidates: userIds.length, batchLimit: CLEANUP_BATCH_SIZE };
    this.deps.logger.info({ mode: "DRY_RUN", ...result }, "student registration cleanup dry-run finished");
    return result;
  }

  async run(): Promise<StudentRegistrationCleanupResult> {
    const jobRunId = await this.deps.runTx((tx) => this.deps.repo.startJobRun(tx));
    let userIds: string[];

    try {
      userIds = await this.deps.runTx((tx) =>
        this.deps.repo.findEligibleUserIds(tx, CLEANUP_BATCH_SIZE),
      );
    } catch (error) {
      await this.deps.runTx((tx) =>
        this.deps.repo.finishJobRun(tx, jobRunId, {
          itemsProcessed: 0,
          itemsFailed: 0,
          status: "FAILED",
        }),
      );
      throw error;
    }

    let itemsDeleted = 0;
    let itemsFailed = 0;
    for (const userId of userIds) {
      try {
        const deleted = await this.deps.runTx((tx) => this.deps.repo.cleanupEligibleUser(tx, userId));
        if (deleted) itemsDeleted += 1;
      } catch (error) {
        itemsFailed += 1;
        this.deps.logger.error({ err: error, userId, jobRunId }, "student registration cleanup item failed");
      }
    }

    const status = finalStatus(userIds.length, itemsFailed);
    await this.deps.runTx((tx) =>
      this.deps.repo.finishJobRun(tx, jobRunId, {
        itemsProcessed: userIds.length,
        itemsFailed,
        status,
      }),
    );

    const result = {
      jobRunId,
      itemsProcessed: userIds.length,
      itemsDeleted,
      itemsFailed,
      status,
    };
    this.deps.logger.info(result, "student registration cleanup run finished");
    return result;
  }
}
