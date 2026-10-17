import { randomUUID } from "node:crypto";

import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { createImportRepository } from "./repository.js";
import { startImportProcessor } from "./processor.js";

const config = loadConfig();
const pool = createPool(config);
const processor = startImportProcessor({
  repository: createImportRepository(pool),
  pool,
  ownerId: `worker-${randomUUID()}`,
  uploadRoot: config.UPLOAD_ROOT,
  reportRoot: config.REPORT_ROOT
});
let stopped = false;

async function shutdown(): Promise<void> {
  if (stopped) return;
  stopped = true;
  processor.stop();
  await pool.end();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void shutdown(); });
process.once("uncaughtException", (error) => { console.error("import worker crashed", error); process.exitCode = 1; void shutdown(); });
process.once("unhandledRejection", (error) => { console.error("import worker rejected", error); process.exitCode = 1; void shutdown(); });
