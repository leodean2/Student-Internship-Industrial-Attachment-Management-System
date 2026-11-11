import { describe, expect, it } from "vitest";
import { createThrottleKeyer } from "../../src/shared/throttle-key";

describe("createThrottleKeyer", () => {
  const email = "student@example.test";

  it("is deterministic for one secret, scope and value", () => {
    const keyer = createThrottleKeyer("secret-one-at-least-32-chars-long");
    expect(keyer.key("reset:email", email)).toBe(keyer.key("reset:email", email));
  });

  it("differs by secret, scope and value", () => {
    const a = createThrottleKeyer("secret-one-at-least-32-chars-long");
    const b = createThrottleKeyer("secret-two-at-least-32-chars-long");
    expect(a.key("reset:email", email)).not.toBe(b.key("reset:email", email));
    expect(a.key("reset:email", email)).not.toBe(a.key("login:email", email));
    expect(a.key("reset:email", email)).not.toBe(a.key("reset:email", "other@example.test"));
  });

  it("never contains the raw value in the output", () => {
    const keyer = createThrottleKeyer("secret-one-at-least-32-chars-long");
    expect(keyer.key("reset:email", email)).not.toContain("student");
    expect(keyer.key("reset:email", email)).not.toContain("example");
  });

  it("uses a random secret per instance when none is given", () => {
    expect(createThrottleKeyer().key("s", email)).not.toBe(createThrottleKeyer().key("s", email));
  });
});
