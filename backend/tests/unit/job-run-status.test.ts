import { describe, expect, it } from "vitest";
import { finalJobRunStatus } from "../../src/modules/email-outbox/job-run-status";

describe("final job-run status", () => {
  it("uses SUCCESS when there are no terminal failures", () => {
    expect(finalJobRunStatus(10, 0)).toBe("SUCCESS");
  });

  it("uses PARTIAL_FAILURE when some messages failed terminally", () => {
    expect(finalJobRunStatus(10, 1)).toBe("PARTIAL_FAILURE");
    expect(finalJobRunStatus(10, 9)).toBe("PARTIAL_FAILURE");
  });

  it("uses FAILED when every claimed message failed terminally", () => {
    expect(finalJobRunStatus(10, 10)).toBe("FAILED");
    expect(finalJobRunStatus(1, 1)).toBe("FAILED");
  });

  it.each([
    [0, 0],
    [-1, 0],
    [5, -1],
    [5, 6],
    [1.5, 0],
  ])("rejects impossible counts (%s, %s)", (processed, failed) => {
    expect(() => finalJobRunStatus(processed, failed)).toThrow(RangeError);
  });
});
