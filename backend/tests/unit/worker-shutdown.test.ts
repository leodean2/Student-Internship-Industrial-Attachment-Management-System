import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/infrastructure/logger";
import { createWorkerShutdownController } from "../../src/modules/email-outbox/worker-shutdown";

describe("worker shutdown controller", () => {
  it("starts a graceful drain and forces stop at the deadline", () => {
    vi.useFakeTimers();
    try {
      const worker = { beginShutdown: vi.fn(), forceStop: vi.fn(() => ["message-1"]) };
      const onHardTimeout = vi.fn();
      const controller = createWorkerShutdownController(worker, 1000, createLogger("silent"), onHardTimeout);

      controller.requestShutdown("SIGTERM");
      expect(worker.beginShutdown).toHaveBeenCalledOnce();
      expect(worker.forceStop).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(worker.forceStop).toHaveBeenCalledOnce();
      expect(onHardTimeout).toHaveBeenCalledWith(["message-1"]);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forces stop immediately when a second signal arrives", () => {
    vi.useFakeTimers();
    try {
      const worker = { beginShutdown: vi.fn(), forceStop: vi.fn(() => []) };
      const onHardTimeout = vi.fn();
      const controller = createWorkerShutdownController(worker, 1000, createLogger("silent"), onHardTimeout);

      controller.requestShutdown("SIGTERM");
      controller.requestShutdown("SIGINT");

      expect(worker.beginShutdown).toHaveBeenCalledOnce();
      expect(worker.forceStop).toHaveBeenCalledOnce();
      expect(onHardTimeout).toHaveBeenCalledWith([]);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
