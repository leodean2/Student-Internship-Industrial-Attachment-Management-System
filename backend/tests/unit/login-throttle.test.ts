import { describe, expect, it } from "vitest";
import { InMemoryAttemptStore, LoginThrottle, type LoginPermit } from "../../src/modules/auth/login-throttle";

const MIN = 60_000;
const WINDOW = 15 * MIN;

function setup(config = { perEmailLimit: 10, perIpLimit: 50, windowMs: WINDOW }, maxKeys?: number) {
  const clock = { now: 1_000_000 };
  const store = new InMemoryAttemptStore(maxKeys);
  const throttle = new LoginThrottle({ store, config, now: () => clock.now });
  /** Reserves an attempt that is left counted (a failed guess). */
  const fail = (ip: string, email: string) => throttle.acquire(ip, email);
  return { clock, store, throttle, fail };
}

describe("per IP + email limit (10 failed attempts per 15 minutes)", () => {
  it("allows 10 attempts and refuses the 11th with the full window as Retry-After", () => {
    const { fail } = setup();
    for (let i = 0; i < 10; i++) expect(fail("1.1.1.1", "a@x.test").allowed).toBe(true);
    const blocked = fail("1.1.1.1", "a@x.test");
    expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 900 });
  });

  it("the window is exact: still blocked 1 ms before it ends, allowed exactly when the first attempt expires", () => {
    const { clock, fail } = setup();
    for (let i = 0; i < 10; i++) fail("1.1.1.1", "a@x.test");
    clock.now += WINDOW - 1;
    expect(fail("1.1.1.1", "a@x.test")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    clock.now += 1; // exactly windowMs after the attempts
    expect(fail("1.1.1.1", "a@x.test").allowed).toBe(true);
  });

  it("slides: only attempts older than the window expire", () => {
    const { clock, fail } = setup();
    for (let i = 0; i < 5; i++) fail("1.1.1.1", "a@x.test"); // at t0
    clock.now += 10 * MIN;
    for (let i = 0; i < 5; i++) fail("1.1.1.1", "a@x.test"); // at t0+10m
    clock.now += 4 * MIN; // t0+14m: all 10 still count
    const blocked = fail("1.1.1.1", "a@x.test");
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterSeconds).toBe(60); // the first 5 expire in one minute
    clock.now += MIN; // t0+15m: the first 5 are gone, the second 5 remain
    for (let i = 0; i < 5; i++) expect(fail("1.1.1.1", "a@x.test").allowed).toBe(true);
    expect(fail("1.1.1.1", "a@x.test").allowed).toBe(false);
  });

  it("is per IP: another address is not locked out by an attacker hammering one account", () => {
    const { fail } = setup();
    for (let i = 0; i < 10; i++) fail("6.6.6.6", "victim@x.test");
    expect(fail("6.6.6.6", "victim@x.test").allowed).toBe(false);
    expect(fail("9.9.9.9", "victim@x.test").allowed).toBe(true);
  });

  it("refused attempts are not recorded, so hammering a locked account cannot extend the lock", () => {
    const { clock, fail } = setup();
    for (let i = 0; i < 10; i++) fail("1.1.1.1", "a@x.test");
    for (let i = 0; i < 200; i++) clock.now += 1000, fail("1.1.1.1", "a@x.test"); // 200 s of refused attempts
    clock.now = 1_000_000 + WINDOW; // the original window ends
    expect(fail("1.1.1.1", "a@x.test").allowed).toBe(true);
  });
});

describe("per IP limit (50 failed attempts per 15 minutes)", () => {
  it("cannot be bypassed by changing the email address", () => {
    const { fail } = setup();
    for (let i = 0; i < 50; i++) expect(fail("1.1.1.1", `user${i}@x.test`).allowed).toBe(true); // every pair count is 1
    expect(fail("1.1.1.1", "brand-new@x.test")).toEqual({ allowed: false, retryAfterSeconds: 900 });
    expect(fail("2.2.2.2", "brand-new@x.test").allowed).toBe(true);
  });

  it("a refused per-email attempt does not use up the IP-wide budget", () => {
    const { fail } = setup({ perEmailLimit: 1, perIpLimit: 3, windowMs: WINDOW });
    const results = [
      fail("1.1.1.1", "e1@x.test"), // ip 1
      fail("1.1.1.1", "e1@x.test"), // refused by the pair limit; must give its IP slot back
      fail("1.1.1.1", "e2@x.test"), // ip 2
      fail("1.1.1.1", "e3@x.test"), // ip 3
      fail("1.1.1.1", "e4@x.test"), // ip full
    ].map((r) => r.allowed);
    expect(results).toEqual([true, false, true, true, false]);
  });
});

describe("permits", () => {
  const permitOf = (r: ReturnType<LoginThrottle["acquire"]>): LoginPermit => {
    if (!r.allowed) throw new Error("expected an allowed attempt");
    return r.permit;
  };

  it("succeeded() clears the IP+email failures but NOT the IP-wide count", () => {
    const { fail, throttle } = setup({ perEmailLimit: 3, perIpLimit: 5, windowMs: WINDOW });
    fail("1.1.1.1", "a@x.test");
    fail("1.1.1.1", "a@x.test"); // 2 failures for the pair, 2 for the IP
    permitOf(throttle.acquire("1.1.1.1", "a@x.test")).succeeded(); // the pair is forgotten; this attempt's IP slot is returned
    for (let i = 0; i < 3; i++) expect(fail("1.1.1.1", "a@x.test").allowed).toBe(true); // a fresh pair budget of 3 (IP now 2+3 = 5)
    expect(fail("1.1.1.1", "a@x.test").allowed).toBe(false);
    expect(fail("1.1.1.1", "other@x.test").allowed).toBe(false); // the IP-wide count was not wiped by the success
  });

  it("refund() gives the slot back on both keys, and settling twice does nothing", () => {
    const { throttle } = setup({ perEmailLimit: 1, perIpLimit: 1, windowMs: WINDOW });
    const permit = permitOf(throttle.acquire("1.1.1.1", "a@x.test"));
    permit.refund();
    permit.refund();
    permit.succeeded();
    expect(throttle.acquire("1.1.1.1", "a@x.test").allowed).toBe(true);
  });
});

describe("memory", () => {
  it("sweeps expired entries", () => {
    const { clock, store, fail } = setup();
    for (let i = 0; i < 20; i++) fail(`10.0.0.${i}`, "a@x.test");
    expect(store.size).toBeGreaterThan(0);
    clock.now += WINDOW + 2 * MIN;
    fail("10.9.9.9", "z@x.test"); // any call after the sweep interval triggers a sweep
    expect(store.size).toBe(2); // only this attempt's two keys remain
  });

  it("is bounded by maxKeys", () => {
    const { store, fail } = setup(undefined, 10);
    for (let i = 0; i < 100; i++) fail(`10.0.1.${i}`, "a@x.test");
    expect(store.size).toBeLessThan(11);
  });
});
