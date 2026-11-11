import type { Logger } from "pino";
import type { ClaimRef } from "./outbox.repository";
import { InterruptibleSleep } from "./interruptible-sleep";

type EntryStatus = "owned" | "lost" | "resolved";

interface Entry extends ClaimRef {
  status: EntryStatus;
  lastConfirmedAt: number;
  uncertainNotified: boolean;
}

export interface LeaseRenewerOptions {
  renewLeases: (claims: readonly ClaimRef[]) => Promise<string[]>;
  leaseDurationMs: number;
  renewalIntervalMs: number;
  now: () => number;
  logger: Logger;
  onOwnershipLost: (id: string) => void;
  onOwnershipUncertain: (id: string) => void;
}

export class LeaseRenewer {
  private readonly entries = new Map<string, Entry>();
  private readonly sleeper = new InterruptibleSleep();
  private readonly uncertainAfterMs: number;
  private running = false;
  private loop: Promise<void> = Promise.resolve();

  constructor(private readonly options: LeaseRenewerOptions) {
    this.uncertainAfterMs = Math.max(0, options.leaseDurationMs - options.renewalIntervalMs);
  }

  track(claims: readonly ClaimRef[], confirmedAt: number): void {
    for (const claim of claims) {
      this.entries.set(claim.id, {
        ...claim,
        status: "owned",
        lastConfirmedAt: confirmedAt,
        uncertainNotified: false,
      });
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.sleeper.interrupt();
    await this.loop;
  }

  forceStop(): void {
    this.running = false;
    this.sleeper.interrupt();
  }

  resolve(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.status = "resolved";
  }

  isOwnershipLost(id: string): boolean {
    return this.entries.get(id)?.status === "lost";
  }

  isOwnershipUncertain(id: string): boolean {
    const entry = this.entries.get(id);
    return Boolean(
      entry &&
      entry.status === "owned" &&
      this.options.now() - entry.lastConfirmedAt >= this.uncertainAfterMs,
    );
  }

  async renewOnce(): Promise<void> {
    const active = [...this.entries.values()].filter((entry) => entry.status === "owned");
    if (active.length === 0) return;

    const requestedAt = this.options.now();
    try {
      const renewedIds = new Set(
        await this.options.renewLeases(active.map(({ id, claimToken }) => ({ id, claimToken }))),
      );
      for (const entry of active) {
        if (entry.status !== "owned") continue;
        if (renewedIds.has(entry.id)) {
          entry.lastConfirmedAt = requestedAt;
          entry.uncertainNotified = false;
        } else {
          entry.status = "lost";
          this.options.logger.warn({ messageId: entry.id }, "outbox lease ownership lost");
          this.notify(() => this.options.onOwnershipLost(entry.id));
        }
      }
    } catch (error) {
      this.options.logger.error({ err: error }, "outbox lease renewal failed");
    }
    this.notifyUncertain();
  }

  private notifyUncertain(): void {
    for (const entry of this.entries.values()) {
      if (entry.status !== "owned" || entry.uncertainNotified || !this.isOwnershipUncertain(entry.id)) continue;
      entry.uncertainNotified = true;
      this.options.logger.warn({ messageId: entry.id }, "outbox lease ownership uncertain");
      this.notify(() => this.options.onOwnershipUncertain(entry.id));
    }
  }

  private notify(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.options.logger.error({ err: error }, "outbox lease callback failed");
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      await this.sleeper.sleep(this.options.renewalIntervalMs);
      if (this.running) await this.renewOnce();
    }
  }
}
