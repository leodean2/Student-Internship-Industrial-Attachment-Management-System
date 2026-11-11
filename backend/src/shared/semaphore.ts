/**
 * Minimal FIFO counting semaphore (Decision #54 §10). A released slot is handed directly to the longest-waiting
 * acquirer, so `inUse` never exceeds `size` and waiters cannot be starved by late arrivals.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError("Semaphore size must be an integer >= 1");
    this.available = size;
  }

  get inUse(): number {
    return this.size - this.available;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /** Resolves with a one-shot release function. Calling it more than once is harmless. */
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
    } else {
      // The slot is transferred by release(); `available` stays unchanged for the handoff.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.available++;
    };
  }

  /** Runs `fn` while holding a slot; the slot is always released, even if `fn` throws. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
