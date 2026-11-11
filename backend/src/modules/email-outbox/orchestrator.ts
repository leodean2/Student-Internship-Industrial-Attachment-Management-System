import type { Logger } from "pino";
import type { Tx, TxRunner } from "../../infrastructure/transaction";
import { Semaphore } from "../../shared/semaphore";
import {
  classifyProviderError,
  ProviderAbortedError,
  ProviderTimeoutError,
  type EmailMessage,
  type EmailProvider,
} from "./email-provider";
import { InterruptibleSleep } from "./interruptible-sleep";
import { LeaseRenewer } from "./lease-renewer";
import type { ClaimedMessage, OutboxRepository } from "./outbox.repository";
import { finalJobRunStatus } from "./job-run-status";
import { decideAfterTransientFailure } from "./retry-policy";
import { sendWithTimeout } from "./provider-call";

export interface OrchestratorConfig {
  batchSize: number;
  concurrency: number;
  pollIntervalMs: number;
  leaseDurationMs: number;
  leaseRenewalIntervalMs: number;
  providerTimeoutMs: number;
  persistRetry?: { baseMs: number; maxMs: number };
}

export interface OrchestratorDeps {
  workerId: string;
  config: OrchestratorConfig;
  repo: OutboxRepository;
  runTx: TxRunner;
  provider: EmailProvider;
  logger: Logger;
  clock?: () => number;
  random?: () => number;
}

export type MessageOutcome = "sent" | "failed" | "retry_scheduled" | "ownership_lost" | "abandoned";
type PersistResult = "persisted" | "ownership_lost" | "abandoned";

interface CycleContext {
  renewer: LeaseRenewer;
  semaphore: Semaphore;
  logger: Logger;
}

function isResolvedOutcome(outcome: MessageOutcome): boolean {
  return outcome !== "abandoned";
}

export class OutboxOrchestrator {
  private shuttingDown = false;
  private hardStopped = false;
  private currentRenewer: LeaseRenewer | undefined;
  private readonly idleSleep = new InterruptibleSleep();
  private readonly persistSleep = new InterruptibleSleep();
  private readonly inFlight = new Map<string, AbortController>();
  private readonly unresolved = new Set<string>();

  private readonly config: OrchestratorConfig;
  private readonly logger: Logger;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly persistRetry: { baseMs: number; maxMs: number };

  constructor(private readonly deps: OrchestratorDeps) {
    this.config = deps.config;
    this.logger = deps.logger.child({ workerId: deps.workerId });
    this.clock = deps.clock ?? (() => performance.now());
    this.random = deps.random ?? Math.random;
    this.persistRetry = deps.config.persistRetry ?? { baseMs: 500, maxMs: 5000 };
    if (!Number.isInteger(this.config.concurrency) || this.config.concurrency < 1) {
      throw new RangeError("concurrency must be a positive integer");
    }
  }

  async run(): Promise<void> {
    this.logger.info("outbox worker loop started");
    while (!this.shuttingDown) {
      let claimed = 0;
      try {
        claimed = await this.runCycle();
      } catch (error) {
        this.logger.error({ err: error }, "outbox cycle failed");
      }
      if (claimed === 0 && !this.shuttingDown) {
        await this.idleSleep.sleep(this.config.pollIntervalMs);
      }
    }
    this.logger.info("outbox worker loop stopped");
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    this.idleSleep.interrupt();
  }

  forceStop(): string[] {
    this.hardStopped = true;
    for (const controller of this.inFlight.values()) controller.abort(new Error("hard shutdown"));
    this.currentRenewer?.forceStop();
    this.persistSleep.interrupt();
    this.idleSleep.interrupt();
    return [...this.unresolved];
  }

  async runCycle(): Promise<number> {
    if (this.shuttingDown) return 0;

    await this.recoverSafely();
    if (this.shuttingDown) return 0;

    const claimStartedAt = this.clock();
    const claimed = await this.deps.runTx((tx) =>
      this.deps.repo.claimBatch(tx, this.config.batchSize, this.config.leaseDurationMs / 1000),
    );
    if (claimed.length === 0) return 0;

    await this.processBatch(claimed, claimStartedAt);
    return claimed.length;
  }

  private async recoverSafely(): Promise<void> {
    try {
      const recovered = await this.deps.runTx((tx) => this.deps.repo.recoverStaleLeases(tx));
      if (recovered.requeued > 0 || recovered.failed > 0) {
        this.logger.info(recovered, "recovered stale outbox leases");
      }
    } catch (error) {
      this.logger.error({ err: error }, "stale-lease recovery failed");
    }
  }

  private async processBatch(claimed: ClaimedMessage[], claimStartedAt: number): Promise<void> {
    const renewer = new LeaseRenewer({
      renewLeases: (claims) =>
        this.deps.runTx((tx) =>
          this.deps.repo.renewLeases(tx, claims, this.config.leaseDurationMs / 1000),
        ),
      leaseDurationMs: this.config.leaseDurationMs,
      renewalIntervalMs: this.config.leaseRenewalIntervalMs,
      now: this.clock,
      logger: this.logger,
      onOwnershipLost: (id) => this.inFlight.get(id)?.abort(new Error("ownership lost")),
      onOwnershipUncertain: (id) => this.inFlight.get(id)?.abort(new Error("ownership uncertain")),
    });
    this.currentRenewer = renewer;
    renewer.track(claimed, claimStartedAt);
    for (const message of claimed) this.unresolved.add(message.id);
    renewer.start();

    const jobRunId = await this.startJobRun(claimed.length);
    const logger = jobRunId ? this.logger.child({ jobRunId }) : this.logger;
    const context: CycleContext = {
      renewer,
      semaphore: new Semaphore(this.config.concurrency),
      logger,
    };

    let outcomes: MessageOutcome[];
    try {
      outcomes = await Promise.all(claimed.map((message) => this.handleMessage(message, context)));
    } finally {
      if (this.hardStopped) renewer.forceStop();
      else await renewer.stop();
      this.currentRenewer = undefined;
    }

    if (this.hardStopped) return;
    const terminalFailures = outcomes.filter((outcome) => outcome === "failed").length;
    await this.finalizeJobRun(jobRunId, claimed.length, terminalFailures, logger);
  }

  private async handleMessage(message: ClaimedMessage, context: CycleContext): Promise<MessageOutcome> {
    const startedAt = this.clock();
    const controller = new AbortController();
    this.inFlight.set(message.id, controller);
    let outcome: MessageOutcome = "abandoned";
    let errorCategory: string | undefined;
    const emailMessage: EmailMessage = {
      id: message.id,
      toEmail: message.toEmail,
      templateType: message.templateType,
      payload: message.payload,
      attempt: message.attempts,
    };

    try {
      const attemptResult = await context.semaphore.run(async () => {
        if (context.renewer.isOwnershipLost(message.id)) return { kind: "ownership_lost" } as const;
        if (this.hardStopped) {
          return { kind: "abandoned" } as const;
        }
        if (context.renewer.isOwnershipUncertain(message.id)) {
          return { kind: "failed", error: new ProviderAbortedError() } as const;
        }
        try {
          await sendWithTimeout(
            this.deps.provider,
            emailMessage,
            this.config.providerTimeoutMs,
            controller.signal,
          );
          return { kind: "sent" } as const;
        } catch (error) {
          return { kind: "failed", error } as const;
        }
      });

      if (attemptResult.kind === "ownership_lost" || attemptResult.kind === "abandoned") {
        outcome = attemptResult.kind;
      } else if (attemptResult.kind === "sent") {
        const persisted = await this.persist(message, context, (tx) => this.deps.repo.markSent(tx, message));
        outcome = persisted === "persisted" ? "sent" : persisted;
      } else {
        const error = attemptResult.error;
        if (error instanceof ProviderAbortedError) {
          if (context.renewer.isOwnershipLost(message.id)) outcome = "ownership_lost";
          else if (this.hardStopped) outcome = "abandoned";
          else {
            errorCategory = "ownership_uncertain";
            outcome = await this.persistFailure(message, context, true);
          }
        } else {
          const failureKind = classifyProviderError(error);
          errorCategory = error instanceof ProviderTimeoutError
            ? "timeout"
            : failureKind === "permanent" ? "permanent" : "transient";
          outcome = await this.persistFailure(message, context, failureKind !== "permanent");
        }
      }
    } catch (error) {
      context.logger.error({ err: error, messageId: message.id }, "unexpected error handling outbox message");
      if (!this.hardStopped && !context.renewer.isOwnershipLost(message.id)) {
        errorCategory = "transient";
        outcome = await this.persistFailure(message, context, true);
      }
    } finally {
      if (isResolvedOutcome(outcome)) {
        context.renewer.resolve(message.id);
        this.unresolved.delete(message.id);
      }
      this.inFlight.delete(message.id);
      context.logger.info(
        {
          messageId: message.id,
          attempts: message.attempts,
          outcome,
          errorCategory,
          durationMs: Math.round(this.clock() - startedAt),
        },
        "outbox message handled",
      );
    }
    return outcome;
  }

  private async persistFailure(
    message: ClaimedMessage,
    context: CycleContext,
    retryable: boolean,
  ): Promise<MessageOutcome> {
    const retry = retryable
      ? decideAfterTransientFailure(message.attempts, this.random)
      : { kind: "fail" as const };
    if (retry.kind === "fail") {
      const result = await this.persist(message, context, (tx) => this.deps.repo.markFailed(tx, message));
      return result === "persisted" ? "failed" : result;
    }
    const result = await this.persist(
      message,
      context,
      (tx) => this.deps.repo.scheduleRetry(tx, message, retry.delayMs),
    );
    return result === "persisted" ? "retry_scheduled" : result;
  }

  private async persist(
    message: ClaimedMessage,
    context: CycleContext,
    operation: (tx: Tx) => Promise<boolean>,
  ): Promise<PersistResult> {
    let failures = 0;
    for (;;) {
      if (context.renewer.isOwnershipLost(message.id)) return "ownership_lost";
      if (this.hardStopped) return "abandoned";
      try {
        const updated = await this.deps.runTx(operation);
        return updated ? "persisted" : "ownership_lost";
      } catch (error) {
        context.logger.error({ err: error, messageId: message.id }, "persisting outbox outcome failed; retrying");
        const wait = Math.min(this.persistRetry.baseMs * 2 ** failures, this.persistRetry.maxMs);
        failures += 1;
        await this.persistSleep.sleep(wait);
      }
    }
  }

  private async startJobRun(itemsProcessed: number): Promise<string | undefined> {
    try {
      return await this.deps.runTx((tx) => this.deps.repo.createJobRun(tx, itemsProcessed));
    } catch (error) {
      this.logger.error({ err: error }, "job-run start failed (telemetry only)");
      return undefined;
    }
  }

  private async finalizeJobRun(
    jobRunId: string | undefined,
    itemsProcessed: number,
    itemsFailed: number,
    logger: Logger,
  ): Promise<void> {
    if (!jobRunId) return;
    try {
      await this.deps.runTx((tx) =>
        this.deps.repo.finalizeJobRun(tx, jobRunId, {
          itemsProcessed,
          itemsFailed,
          status: finalJobRunStatus(itemsProcessed, itemsFailed),
        }),
      );
    } catch (error) {
      logger.error({ err: error }, "job-run finalize failed (telemetry only)");
    }
  }
}
