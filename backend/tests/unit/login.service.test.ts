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
});

describe("account state is revealed only after a correct password (decision 3)", () => {
  it("a correct password for an inactive account gives ACCOUNT_INACTIVE and opens no session", async () => {
    const { login, calls } = setup();
    expect(await rejection(login({ email: "sleepy@x.test" }))).toMatchObject({ status: 401, code: "ACCOUNT_INACTIVE" });
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

  it("an inactive account probed with the correct password does not count towards the lockout", async () => {
    const { login } = setup();
    for (let i = 0; i < 30; i++) expect(await rejection(login({ email: "sleepy@x.test" }))).toMatchObject({ code: "ACCOUNT_INACTIVE" });
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
