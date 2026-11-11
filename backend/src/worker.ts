import { config } from "dotenv";
config();

import { PrismaPg } from "@prisma/adapter-pg";
import { loadWorkerEnv } from "./config/env";
import { createLogger } from "./infrastructure/logger";
import { createPrismaClient } from "./infrastructure/prisma";
import { prismaTxRunner } from "./infrastructure/transaction";
import { createEmailProvider } from "./modules/email-outbox/create-email-provider";
import { OutboxOrchestrator } from "./modules/email-outbox/orchestrator";
import { PrismaOutboxRepository } from "./modules/email-outbox/outbox.repository";
import { createWorkerShutdownController } from "./modules/email-outbox/worker-shutdown";

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const provider = createEmailProvider(env, logger);
  const prisma = createPrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  const worker = new OutboxOrchestrator({
    workerId: `outbox-${process.pid}`,
    config: {
      batchSize: env.WORKER_BATCH_SIZE,
      concurrency: env.WORKER_CONCURRENCY,
      pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
      leaseDurationMs: env.WORKER_LEASE_DURATION_MS,
      leaseRenewalIntervalMs: env.WORKER_LEASE_RENEWAL_INTERVAL_MS,
      providerTimeoutMs: env.WORKER_PROVIDER_TIMEOUT_MS,
    },
    repo: new PrismaOutboxRepository(),
    runTx: prismaTxRunner(prisma),
    provider,
    logger,
  });

  const shutdown = createWorkerShutdownController(worker, env.SHUTDOWN_TIMEOUT_MS, logger, (unresolvedIds) => {
    if (unresolvedIds.length > 0) {
      logger.error({ unresolvedCount: unresolvedIds.length }, "worker stopped with unresolved outbox messages");
    }
    process.exit(1);
  });
  const onSigterm = () => shutdown.requestShutdown("SIGTERM");
  const onSigint = () => shutdown.requestShutdown("SIGINT");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  try {
    logger.info(
      { provider: env.EMAIL_PROVIDER, batchSize: env.WORKER_BATCH_SIZE, concurrency: env.WORKER_CONCURRENCY },
      "outbox worker starting",
    );
    await worker.run();
  } finally {
    shutdown.dispose();
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    try {
      await prisma.$disconnect();
    } catch (error) {
      logger.error({ err: error }, "failed to disconnect worker database client");
      process.exitCode = 1;
    }
  }
}

void main().catch((error: unknown) => {
  console.error("Email outbox worker failed to start", error);
  process.exitCode = 1;
});
