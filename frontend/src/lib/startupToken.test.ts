import { describe, expect, it, vi } from "vitest";
import { captureStartupToken, clearStartupToken, getStartupToken } from "./startupToken";

const address = () => window.location.pathname + window.location.search + window.location.hash;

describe("startup token", () => {
  it("reads and removes the token while preserving other URL state", () => {
    window.history.replaceState({ k: 1 }, "", "/verify-email?token=abc123&ref=x#top");
    captureStartupToken();
    expect(getStartupToken()).toBe("abc123");
    expect(address()).toBe("/verify-email?ref=x#top");
    expect(window.history.state).toEqual({ k: 1 });
  });

  it("does nothing when there is no token", () => {
    window.history.replaceState(null, "", "/verify-email?ref=x");
    captureStartupToken();
    expect(getStartupToken()).toBeNull();
    expect(address()).toBe("/verify-email?ref=x");
  });

  it("treats an empty token as missing but still removes it from the URL", () => {
    window.history.replaceState(null, "", "/reset-password?token=");
    captureStartupToken();
    expect(getStartupToken()).toBeNull();
    expect(address()).toBe("/reset-password");
  });

  it("can be cleared", () => {
    window.history.replaceState(null, "", "/verify-email?token=abc");
    captureStartupToken();
    clearStartupToken();
    expect(getStartupToken()).toBeNull();
  });

  it("never writes the token to browser storage", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    window.history.replaceState(null, "", "/verify-email?token=abc");
    captureStartupToken();
    expect(setItem).not.toHaveBeenCalled();
  });
});
