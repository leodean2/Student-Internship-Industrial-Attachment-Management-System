import { mkdirSync } from "fs";
const dirs = [
  "prisma/migrations/20261107000000_outbox_worker_columns",
  "src/worker",
  "tests/integration/worker",
];
for (const d of dirs) mkdirSync(d, { recursive: true });
console.log("done");
