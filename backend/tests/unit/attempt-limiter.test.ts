import { describe, expect, it } from "vitest";
import { AttemptLimiter } from "../../src/shared/security/attempt-limiter";
import { InMemoryAttemptStore } from "../../src/shared/security/attempt-store";

const MIN = 60_000;
function setup(limit = 10, windowMs = 15 * MIN) {
  const clock = { now: 1_000_000 };
  const limiter = new AttemptLimiter({ limit, windowMs, now: () => clock.now });
  return { clock, limiter };
}

describe("AttemptLimiter (reserve and refund)", () => {
  it("allows `limit` attempts per key and refuses the next with the whole window as Retry-After", () => {
    const { limiter } = setup();
    for (let i = 0; i < 10; i++) expect(limiter.acquire("1.1.1.1").allowed).toBe(true);
    expect(limiter.acquire("1.1.1.1")).toEqual({ allowed: false, retryAfterSeconds: 900 });
  });

  it("keys are independent", () => {
    const { limiter } = setup(1);
    expect(limiter.acquire("a").allowed).toBe(true);
    expect(limiter.acquire("a").allowed).toBe(false);
    expect(limiter.acquire("b").allowed).toBe(true);
  });

  it("the window is exact: refused 1 ms before it ends, allowed exactly when the first attempt expires", () => {
    const { clock, limiter } = setup(2);
    limiter.acquire("k");
    limiter.acquire("k");
    clock.now += 15 * MIN - 1;
    expect(limiter.acquire("k")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    clock.now += 1;
    expect(limiter.acquire("k").allowed).toBe(true);
  });

  it("refund() gives the slot back, once", () => {
    const { limiter } = setup(1);
    const first = limiter.acquire("k");
    if (!first.allowed) throw new Error("expected allowed");
    first.permit.refund();
    first.permit.refund();
    const second = limiter.acquire("k");
    expect(second.allowed).toBe(true);
    expect(limiter.acquire("k").allowed).toBe(false);
  });

  it("refused attempts are not recorded, so hammering cannot extend the lock", () => {
    const { clock, limiter } = setup(1);
    limiter.acquire("k");
    for (let i = 0; i < 300; i++) {
      clock.now += 1000;
      limiter.acquire("k");
    }
    clock.now = 1_000_000 + 15 * MIN;
    expect(limiter.acquire("k").allowed).toBe(true);
  });

  it("is race-free: simultaneous reservations can never exceed the limit", () => {
    const { limiter } = setup(10);
    const results = Array.from({ length: 25 }, () => limiter.acquire("k"));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it("owns its store by default, so two limiters never share counters; a shared store is opt-in", () => {
    const a = new AttemptLimiter({ limit: 1, windowMs: MIN, now: () => 5 });
    const b = new AttemptLimiter({ limit: 1, windowMs: MIN, now: () => 5 });
    expect(a.acquire("k").allowed).toBe(true);
    expect(b.acquire("k").allowed).toBe(true);
    const store = new InMemoryAttemptStore();
    const c = new AttemptLimiter({ limit: 1, windowMs: MIN, store, now: () => 5 });
    const d = new AttemptLimiter({ limit: 1, windowMs: MIN, store, now: () => 5 });
    expect(c.acquire("k").allowed).toBe(true);
    expect(d.acquire("k").allowed).toBe(false);
  });

  it("rejects nonsense configuration", () => {
    expect(() => new AttemptLimiter({ limit: 0, windowMs: MIN })).toThrow();
    expect(() => new AttemptLimiter({ limit: 1.5, windowMs: MIN })).toThrow();
    expect(() => new AttemptLimiter({ limit: 1, windowMs: 0 })).toThrow();
  });
});
