import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { Tx, TxRunner } from "../../src/infrastructure/transaction";
import { OutboxOrchestrator, type OrchestratorConfig } from "../../src/modules/email-outbox/orchestrator";
import {
  type ClaimRef,
  type ClaimedMessage,
  type OutboxRepository,
} from "../../src/modules/email-outbox/outbox.repository";
import { PermanentEmailError, type EmailProvider } from "../../src/modules/email-outbox/email-provider";

const config: OrchestratorConfig = {
  batchSize: 10,
  concurrency: 5,
  pollIntervalMs: 20,
  leaseDurationMs: 400,
  leaseRenewalIntervalMs: 20,
  providerTimeoutMs: 100,
  persistRetry: { baseMs: 5, maxMs: 20 },
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function message(id: string, attempts = 1): ClaimedMessage {
  return {
    id,
    toEmail: `${id}@example.test`,
    templateType: "test",
    payload: {},
    attempts,
    claimToken: `claim-${id}`,
  };
}

const successfulProvider: EmailProvider = { send: async () => undefined };
const hangingProvider: EmailProvider = {
  send: (_message, signal) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
};

function build(options: {
  messages?: ClaimedMessage[];
  provider?: EmailProvider;
  config?: Partial<OrchestratorConfig>;
  repo?: Partial<OutboxRepository>;
} = {}) {
  const repo: OutboxRepository = {
    enqueue: vi.fn(async () => ({ created: true })),
    recoverStaleLeases: vi.fn(async () => ({ requeued: 0, failed: 0 })),
    claimBatch: vi.fn(async () => options.messages ?? []),
    renewLeases: vi.fn(async (_tx, claims: readonly ClaimRef[]) => claims.map(({ id }) => id)),
    markSent: vi.fn(async () => true),
    markFailed: vi.fn(async () => true),
    scheduleRetry: vi.fn(async () => true),
    createJobRun: vi.fn(async () => "job-1"),
    finalizeJobRun: vi.fn(async () => undefined),
    ...options.repo,
  };
  const runTx: TxRunner = async (operation) => operation(undefined as unknown as Tx);
  const orchestrator = new OutboxOrchestrator({
    workerId: "test-worker",
    config: { ...config, ...options.config },
    repo,
    runTx,
    provider: options.provider ?? successfulProvider,
    logger: pino({ level: "silent" }),
    random: () => 0.5,
  });
  return { repo, orchestrator };
}

describe("OutboxOrchestrator", () => {
  it("sends a claimed batch and finalizes job-run telemetry", async () => {
    const { repo, orchestrator } = build({ messages: [message("a"), message("b")] });
    expect(await orchestrator.runCycle()).toBe(2);
    expect(repo.markSent).toHaveBeenCalledTimes(2);
    expect(repo.createJobRun).toHaveBeenCalledWith(undefined, 2);
    expect(repo.finalizeJobRun).toHaveBeenCalledWith(undefined, "job-1", {
      itemsProcessed: 2,
      itemsFailed: 0,
      status: "SUCCESS",
    });
  });

  it("does not create job-run telemetry for an empty batch", async () => {
    const { repo, orchestrator } = build();
    expect(await orchestrator.runCycle()).toBe(0);
    expect(repo.createJobRun).not.toHaveBeenCalled();
  });

  it("schedules a transient retry using the attempt-specific backoff", async () => {
    const provider: EmailProvider = { send: async () => { throw new Error("temporary provider error"); } };
    const { repo, orchestrator } = build({ messages: [message("retry", 2)], provider });
    await orchestrator.runCycle();
    expect(repo.scheduleRetry).toHaveBeenCalledWith(undefined, expect.objectContaining({ id: "retry" }), 300_000);
    expect(repo.finalizeJobRun).toHaveBeenCalledWith(undefined, "job-1", expect.objectContaining({
      status: "SUCCESS",
      itemsFailed: 0,
    }));
  });

  it("fails terminally after a transient failure on attempt five", async () => {
    const provider: EmailProvider = { send: async () => { throw new Error("temporary provider error"); } };
    const { repo, orchestrator } = build({ messages: [message("last", 5)], provider });
    await orchestrator.runCycle();
    expect(repo.markFailed).toHaveBeenCalledTimes(1);
    expect(repo.scheduleRetry).not.toHaveBeenCalled();
    expect(repo.finalizeJobRun).toHaveBeenCalledWith(undefined, "job-1", expect.objectContaining({
      status: "FAILED",
      itemsFailed: 1,
    }));
  });

  it("fails permanent provider errors immediately", async () => {
    const provider: EmailProvider = {
      send: async () => { throw new PermanentEmailError("invalid recipient"); },
    };
    const { repo, orchestrator } = build({ messages: [message("permanent")], provider });
    await orchestrator.runCycle();
    expect(repo.markFailed).toHaveBeenCalledTimes(1);
    expect(repo.scheduleRetry).not.toHaveBeenCalled();
  });

  it("treats a provider timeout as transient and schedules a retry", async () => {
    const provider: EmailProvider = {
      send: () => new Promise(() => undefined),
    };
    const { repo, orchestrator } = build({
      messages: [message("timeout")],
      provider,
      config: { providerTimeoutMs: 10 },
    });
    await orchestrator.runCycle();
    expect(repo.scheduleRetry).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ id: "timeout" }),
      60_000,
    );
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it("does not write a completion or count a message after ownership is lost", async () => {
    const { repo, orchestrator } = build({
      messages: [message("lost")],
      provider: hangingProvider,
      config: { leaseRenewalIntervalMs: 5 },
      repo: { renewLeases: vi.fn(async () => []) },
    });
    const cycle = orchestrator.runCycle();
    await delay(20);
    await cycle;
    expect(repo.markSent).not.toHaveBeenCalled();
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(repo.scheduleRetry).not.toHaveBeenCalled();
    expect(repo.finalizeJobRun).toHaveBeenCalledWith(undefined, "job-1", expect.objectContaining({
      status: "SUCCESS",
      itemsFailed: 0,
    }));
  });

  it("renews queued messages while waiting for a concurrency slot", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider: EmailProvider = { send: async () => gate };
    const { repo, orchestrator } = build({
      messages: [message("a"), message("b")],
      provider,
      config: { concurrency: 1, leaseRenewalIntervalMs: 5 },
    });
    const cycle = orchestrator.runCycle();
    await delay(18);
    const renewedBoth = vi.mocked(repo.renewLeases).mock.calls.some(([, claims]) =>
      claims.map(({ id }) => id).sort().join(",") === "a,b");
    release();
    await cycle;
    expect(renewedBoth).toBe(true);
  });

  it("continues renewal and persists outcomes after graceful shutdown begins", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { repo, orchestrator } = build({
      messages: [message("shutdown")],
      provider: { send: async () => gate },
      config: { leaseRenewalIntervalMs: 5 },
    });
    const cycle = orchestrator.runCycle();
    await delay(12);
    orchestrator.beginShutdown();
    const previousRenewals = vi.mocked(repo.renewLeases).mock.calls.length;
    await delay(15);
    expect(vi.mocked(repo.renewLeases).mock.calls.length).toBeGreaterThan(previousRenewals);
    release();
    await cycle;
    expect(repo.markSent).toHaveBeenCalledTimes(1);
  });

  it("does not start recovery or claim work after shutdown begins", async () => {
    const { repo, orchestrator } = build({ messages: [message("unused")] });
    orchestrator.beginShutdown();
    expect(await orchestrator.runCycle()).toBe(0);
    expect(repo.recoverStaleLeases).not.toHaveBeenCalled();
    expect(repo.claimBatch).not.toHaveBeenCalled();
  });

  it("interrupts polling sleep when shutdown begins", async () => {
    const { orchestrator } = build({ config: { pollIntervalMs: 60_000 } });
    const running = orchestrator.run();
    await delay(10);
    orchestrator.beginShutdown();
    await running;
  });

  it("retries completion persistence and isolates telemetry failures", async () => {
    const { repo, orchestrator } = build({
      messages: [message("persist")],
      repo: {
        markSent: vi.fn().mockRejectedValueOnce(new Error("database down")).mockResolvedValue(true),
        createJobRun: vi.fn(async () => { throw new Error("telemetry down"); }),
      },
    });
    await orchestrator.runCycle();
    expect(repo.markSent).toHaveBeenCalledTimes(2);
    expect(repo.finalizeJobRun).not.toHaveBeenCalled();
  });

  it("force-stops provider calls and reports messages without persisted outcomes", async () => {
    const { repo, orchestrator } = build({
      messages: [message("unresolved")],
      provider: hangingProvider,
    });
    const cycle = orchestrator.runCycle();
    await delay(10);
    expect(orchestrator.forceStop()).toEqual(["unresolved"]);
    await cycle;
    expect(repo.markSent).not.toHaveBeenCalled();
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(repo.scheduleRetry).not.toHaveBeenCalled();
    expect(repo.finalizeJobRun).not.toHaveBeenCalled();
  });
});
