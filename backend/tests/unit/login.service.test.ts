import { describe, expect, it } from "vitest";
import { AppError, Errors } from "../../src/shared/errors";
import { LoginThrottle } from "../../src/modules/auth/login-throttle";
import { INVALID_CREDENTIALS_MESSAGE, LoginService, type LoginInput } from "../../src/modules/auth/login.service";

const DUMMY = "dummy-hash";

function setup(
  options: {
    actorLoad?: (id: string) => Promise<unknown>;
    findByEmail?: (e: string) => Promise<{ userId: string; passwordHash: string } | null>;
    verify?: (plain: string, hash: string) => boolean;
  } = {},
) {
  const clock = { now: 1_000_000 };
  const users = new Map([
    ["stu@x.test", { userId: "stu", passwordHash: "hash:right-password" }],
    ["sleepy@x.test", { userId: "sleepy", passwordHash: "hash:right-password" }],
    ["norole@x.test", { userId: "norole", passwordHash: "hash:right-password" }],
  ]);
  const calls = { verify: [] as { plain: string; hash: string }[], startSession: [] as string[], warnings: [] as object[] };
  const service = new LoginService({
    credentials: { findByEmail: options.findByEmail ?? (async (email) => users.get(email) ?? null) },
    actors: {
      load:
        options.actorLoad ??
        (async (id) => {
          if (id === "sleepy") throw Errors.accountInactive();
          if (id === "norole") throw Errors.unauthenticated();
          return {};
        }),
    },
    sessions: {
      startSession: async (userId) => {
        calls.startSession.push(userId);
        return { token: `refresh-${userId}`, expiresAt: new Date(0) };
      },
    },
    tokens: { sign: (userId) => `access-${userId}`, ttlSeconds: 900 },
    throttle: new LoginThrottle({ now: () => clock.now }),
    passwords: {
      verify: async (plain, hash) => {
        calls.verify.push({ plain, hash });
        return options.verify ? options.verify(plain, hash) : hash === `hash:${plain}`;
      },
      dummyHash: async () => DUMMY,
    },
    refreshTtlSeconds: 604_800,
    logger: { warn: (obj) => void calls.warnings.push(obj) },
  });
  const login = (over: Partial<LoginInput> = {}) =>
    service.login({ email: "stu@x.test", password: "right-password", ip: "1.1.1.1", ...over });
  return { service, login, calls, clock };
}

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error("expected a rejection");
}

describe("successful login", () => {
  it("opens a session and returns both tokens, with the cookie lifetime of a fresh refresh token", async () => {
    const { login, calls } = setup();
    expect(await login()).toEqual({
      accessToken: "access-stu",
      accessExpiresInSeconds: 900,
      refreshToken: "refresh-stu",
      refreshMaxAgeSeconds: 604_800,
    });
    expect(calls.startSession).toEqual(["stu"]);
  });
});

describe("credential failures are indistinguishable (decision 3)", () => {
  it("unknown email and wrong password give the identical 401, and each costs exactly one comparison", async () => {
    const { login, calls } = setup();
    const unknown = await rejection(login({ email: "nobody@x.test", password: "whatever" }));
    const wrong = await rejection(login({ password: "wrong-password" }));
    expect(unknown).toMatchObject({ status: 401, code: "UNAUTHENTICATED", message: INVALID_CREDENTIALS_MESSAGE });
    expect(wrong).toMatchObject({ status: 401, code: "UNAUTHENTICATED", message: INVALID_CREDENTIALS_MESSAGE });
    expect(unknown.message).toBe(wrong.message);
    expect(calls.verify).toHaveLength(2);
    expect(calls.verify[0]).toEqual({ plain: "whatever", hash: DUMMY }); // the dummy hash stands in for the missing account
    expect(calls.startSession).toHaveLength(0);
  });

  it("an unknown email can never succeed, even if the comparison itself were to report a match", async () => {
    const { login, calls } = setup({ verify: () => true });
    expect(await rejection(login({ email: "nobody@x.test" }))).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(calls.startSession).toHaveLength(0);
  });

  // L1: all five failure paths return the identical code, status and message (#55 / decision 3)
  it("L1: unknown email, wrong password, pending, deactivated and role-less all return the identical 401 (L1)", async () => {
    const scenarios: Array<{ label: string; override: Parameters<typeof setup>[0] & { email?: string } }> = [
      { label: "unknown email",  override: { findByEmail: async () => null } },
      { label: "wrong password", override: { verify: () => false } },
      { label: "pending",        override: { actorLoad: async () => { throw Errors.accountInactive(); } } },
      { label: "deactivated",    override: { actorLoad: async () => { throw Errors.accountInactive(); } } },
      { label: "role-less",      override: { actorLoad: async () => { throw Errors.unauthenticated(); } } },
    ];
    const outcomes: string[] = [];
    for (const { override } of scenarios) {
      const { login } = setup(override);
      const err = await rejection(login());
      outcomes.push(JSON.stringify({ code: err.code, status: err.status, message: err.message }));
    }
    // All five must be identical
    expect(new Set(outcomes).size).toBe(1);
    const parsed = JSON.parse(outcomes[0]!);
    expect(parsed).toEqual({ code: "UNAUTHENTICATED", status: 401, message: INVALID_CREDENTIALS_MESSAGE });
  });

  // L2: exactly one password comparison on every failing path
  it("L2: passwords.verify is called exactly once on every failing path; unknown email uses the dummy hash", async () => {
    const scenarios: Array<{ label: string; override: Parameters<typeof setup>[0] }> = [
      { label: "unknown email",  override: { findByEmail: async () => null } },
      { label: "wrong password", override: { verify: () => false } },
      { label: "pending",        override: { actorLoad: async () => { throw Errors.accountInactive(); } } },
      { label: "deactivated",    override: { actorLoad: async () => { throw Errors.accountInactive(); } } },
      { label: "role-less",      override: { actorLoad: async () => { throw Errors.unauthenticated(); } } },
    ];
    for (const { label, override } of scenarios) {
      const { login, calls } = setup(override);
      await rejection(login());
      expect(calls.verify).toHaveLength(1), `${label}: expected exactly one verify call`;
      if (label === "unknown email") {
        expect(calls.verify[0]!.hash).toBe(DUMMY);
      }
    }
  });

  // L3: no side effects on any failing path
  it("L3: sessions.startSession is never called on a failing path; actors.load only runs after a correct password", async () => {
    const actorCalls: string[] = [];
    const { login, calls } = setup({
      actorLoad: async (id) => { actorCalls.push(id); throw Errors.accountInactive(); },
    });

    // Wrong password: actors.load must NOT be called
    await rejection(login({ password: "wrong" }));
    expect(actorCalls).toHaveLength(0);
    expect(calls.startSession).toHaveLength(0);

    // Unknown email: actors.load must NOT be called
    await rejection(login({ email: "nobody@x.test" }));
    expect(actorCalls).toHaveLength(0);
    expect(calls.startSession).toHaveLength(0);

    // Correct password but actor denial: actors.load IS called, startSession is NOT
    await rejection(login({ email: "sleepy@x.test" }));
    expect(actorCalls).toHaveLength(1);
    expect(calls.startSession).toHaveLength(0);
  });
});

describe("account state handling after a correct password (decision 3 / #55)", () => {
  it("a correct password on an inactive account returns the generic failure (not ACCOUNT_INACTIVE)", async () => {
    const { login, calls } = setup();
    const err = await rejection(login({ email: "sleepy@x.test" }));
    expect(err).toMatchObject({ status: 401, code: "UNAUTHENTICATED", message: INVALID_CREDENTIALS_MESSAGE });
    expect(calls.startSession).toHaveLength(0);
  });

  it("a WRONG password for an inactive account gives the generic failure, revealing nothing", async () => {
    const { login } = setup();
    expect(await rejection(login({ email: "sleepy@x.test", password: "nope" }))).toMatchObject({
      code: "UNAUTHENTICATED",
      message: INVALID_CREDENTIALS_MESSAGE,
    });
  });

  it("a user with no role (e.g. the SYSTEM user) is refused with the generic failure and gets no session", async () => {
    const { login, calls } = setup();
    expect(await rejection(login({ email: "norole@x.test" }))).toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
      message: INVALID_CREDENTIALS_MESSAGE,
    });
    expect(calls.startSession).toHaveLength(0);
  });

  it("a correct password on an inactive account counts as a failed attempt (L4)", async () => {
    const { login } = setup();
    for (let i = 0; i < 10; i++) expect(await rejection(login({ email: "sleepy@x.test" }))).toMatchObject({ code: "UNAUTHENTICATED" });
    // The 11th attempt on the same IP+email is now rate-limited.
    expect(await rejection(login({ email: "sleepy@x.test" }))).toMatchObject({ status: 429, code: "RATE_LIMITED" });
  });
});

describe("throttling (decision 2)", () => {
  it("refuses the 11th failed attempt with 429 and Retry-After, even with the correct password", async () => {
    const { login, calls } = setup();
    for (let i = 0; i < 10; i++) expect(await rejection(login({ password: "wrong" }))).toMatchObject({ status: 401 });
    const blocked = await rejection(login()); // correct password
    expect(blocked).toMatchObject({ status: 429, code: "RATE_LIMITED", retryAfterSeconds: 900 });
    expect(calls.verify).toHaveLength(10); // the refused attempt did no password work
    expect(calls.startSession).toHaveLength(0);
    expect(calls.warnings).toHaveLength(1);
    expect(JSON.stringify(calls.warnings)).not.toContain("stu@x.test");
    expect(JSON.stringify(calls.warnings)).not.toContain("right-password");
  });

  it("is race-free: 25 simultaneous wrong guesses let exactly 10 through", async () => {
    const { login, calls } = setup();
    const results = await Promise.allSettled(Array.from({ length: 25 }, () => login({ password: "wrong" })));
    const refused = results.filter((r) => r.status === "rejected" && (r.reason as AppError).status === 429);
    expect(calls.verify).toHaveLength(10);
    expect(refused).toHaveLength(15);
  });

  it("a success forgets the IP+email failures but not the IP-wide count", async () => {
    const { login } = setup();
    for (let i = 0; i < 9; i++) await rejection(login({ password: "wrong" }));
    await login(); // success resets this IP+email
    for (let i = 0; i < 10; i++) expect(await rejection(login({ password: "wrong" }))).toMatchObject({ status: 401 });
    expect(await rejection(login({ password: "wrong" }))).toMatchObject({ status: 429 });

    // IP-wide: 49 failures on different emails, then a success must not wipe the count
    const other = setup();
    for (let i = 0; i < 49; i++) await rejection(other.login({ email: `u${i}@x.test` }));
    await other.login(); // success
    expect(await rejection(other.login({ email: "x1@x.test" }))).toMatchObject({ status: 401 }); // the 50th
    expect(await rejection(other.login({ email: "x2@x.test" }))).toMatchObject({ status: 429 }); // the 51st
  });

  it("recovers after the window passes", async () => {
    const { login, clock } = setup();
    for (let i = 0; i < 10; i++) await rejection(login({ password: "wrong" }));
    expect(await rejection(login())).toMatchObject({ status: 429 });
    clock.now += 15 * 60_000;
    expect(await login()).toMatchObject({ accessToken: "access-stu" });
  });

  it("an infrastructure error is rethrown and does not count as a failed guess", async () => {
    const { login } = setup({ findByEmail: async () => { throw new Error("db down"); } });
    for (let i = 0; i < 60; i++) expect((await rejection(login())).message).toBe("db down");
  });
});

describe("global per-email throttling", () => {
  const ipOf = (i: number) => `10.0.${Math.floor(i / 250)}.${i % 250}`;

  it("refuses the 31st attempt before password work, even if the password is correct", async () => {
    const { login, calls } = setup();
    for (let i = 0; i < 30; i++) {
      expect(await rejection(login({ password: "wrong", ip: ipOf(i) }))).toMatchObject({ status: 401 });
    }
    const blocked = await rejection(login({ ip: ipOf(99) }));
    expect(blocked).toMatchObject({ status: 429, code: "RATE_LIMITED", retryAfterSeconds: 900 });
    expect(calls.verify).toHaveLength(30);
    expect(calls.startSession).toHaveLength(0);
  });

  it("refuses known and unknown emails identically", async () => {
    const known = setup();
    const unknown = setup();
    for (let i = 0; i < 30; i++) {
      await rejection(known.login({ password: "wrong", ip: ipOf(i) }));
      await rejection(unknown.login({ email: "nobody@x.test", password: "wrong", ip: ipOf(i) }));
    }
    const knownBlocked = await rejection(known.login({ ip: ipOf(99) }));
    const unknownBlocked = await rejection(unknown.login({ email: "nobody@x.test", ip: ipOf(99) }));
    for (const error of [knownBlocked, unknownBlocked]) {
      expect(error).toMatchObject({
        status: 429,
        code: "RATE_LIMITED",
        message: "Too many attempts. Please try again later.",
        retryAfterSeconds: 900,
      });
    }
  });

  it("allows login again when the window expires", async () => {
    const { login, clock } = setup();
    for (let i = 0; i < 30; i++) await rejection(login({ password: "wrong", ip: ipOf(i) }));
    expect(await rejection(login({ ip: ipOf(99) }))).toMatchObject({ status: 429 });
    clock.now += 15 * 60_000;
    expect(await login({ ip: ipOf(99) })).toMatchObject({ accessToken: "access-stu" });
  });

  it("a successful login returns only its own slot; previous failures remain counted", async () => {
    const { login } = setup();
    for (let i = 0; i < 29; i++) await rejection(login({ password: "wrong", ip: ipOf(i) }));
    await login({ ip: ipOf(200) });
    expect(await rejection(login({ password: "wrong", ip: ipOf(201) }))).toMatchObject({ status: 401 });
    expect(await rejection(login({ password: "wrong", ip: ipOf(202) }))).toMatchObject({ status: 429 });
  });

  it("correct passwords on inactive accounts count against the global limit", async () => {
    const { login } = setup();
    for (let i = 0; i < 30; i++) {
      expect(await rejection(login({ email: "sleepy@x.test", ip: ipOf(i) }))).toMatchObject({ code: "UNAUTHENTICATED" });
    }
    // The 31st attempt, from a fresh IP, is now globally rate-limited.
    expect(await rejection(login({ email: "sleepy@x.test", ip: ipOf(99) }))).toMatchObject({ status: 429, code: "RATE_LIMITED" });
  });
});
