import { config as loadDotEnv } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";
import { createLogger } from "../../infrastructure/logger";
import { createPrismaClient } from "../../infrastructure/prisma";
import { prismaTxRunner } from "../../infrastructure/transaction";
import { PrismaStudentRegistrationCleanupRepository } from "./cleanup.repository";
import { StudentRegistrationCleanupService } from "./cleanup.service";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--execute")) {
    throw new Error("Usage: npm run cleanup:student-registrations [-- --execute]");
  }
  const execute = args[0] === "--execute";

  loadDotEnv();
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) throw new Error("DATABASE_URL is required to run student registration cleanup.");

  const logger = createLogger(process.env["LOG_LEVEL"] ?? "info");
  const prisma = createPrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    const cleanup = new StudentRegistrationCleanupService({
      repo: new PrismaStudentRegistrationCleanupRepository(),
      runTx: prismaTxRunner(prisma),
      logger,
    });
    if (execute) {
      const result = await cleanup.run();
      if (result.itemsFailed > 0) process.exitCode = 1;
    } else {
      await cleanup.preview();
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error("Student registration cleanup failed", error);
  process.exitCode = 1;
});
