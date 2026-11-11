import type { Logger } from "pino";

export interface ShutdownTarget {
  beginShutdown(): void;
  forceStop(): string[];
}

export interface WorkerShutdownController {
  requestShutdown(signal: string): void;
  dispose(): void;
}

export function createWorkerShutdownController(
  worker: ShutdownTarget,
  timeoutMs: number,
  logger: Logger,
  onHardTimeout: (unresolvedIds: string[]) => void,
): WorkerShutdownController {
  let shuttingDown = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    requestShutdown(signal) {
      if (shuttingDown) {
        const unresolvedIds = worker.forceStop();
        logger.error({ signal, unresolvedCount: unresolvedIds.length }, "worker received another shutdown signal; forcing stop");
        onHardTimeout(unresolvedIds);
        return;
      }

      shuttingDown = true;
      logger.info({ signal, timeoutMs }, "worker graceful shutdown started");
      worker.beginShutdown();
      timer = setTimeout(() => {
        const unresolvedIds = worker.forceStop();
        logger.error({ signal, unresolvedCount: unresolvedIds.length }, "worker shutdown deadline exceeded");
        onHardTimeout(unresolvedIds);
      }, timeoutMs);
      timer.unref();
    },
    dispose() {
      if (timer) clearTimeout(timer);
    },
  };
}
