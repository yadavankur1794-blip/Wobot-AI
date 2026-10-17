import { resolve } from "node:path";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { createImportRepository } from "./imports/repository.js";
import { createUploadStorage } from "./imports/storage.js";
import { startWorkerSupervisor, type WorkerSupervisor } from "./imports/supervisor.js";

const config = loadConfig();
const pool = createPool(config);
const app = buildApp({ database: pool, logLevel: config.LOG_LEVEL, uploadRoot: config.UPLOAD_ROOT, reportRoot: config.REPORT_ROOT });
let worker: WorkerSupervisor | null = null;
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ signal }, "shutdown started");
  try {
    if (worker) await worker.stop();
    await app.close();
    await pool.end();
    app.log.info("shutdown complete");
  } catch (error: unknown) {
    app.log.error({ err: error }, "shutdown failed");
    process.exitCode = 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await runMigrations(pool, resolve(process.env.MIGRATIONS_DIR ?? "migrations"));
  const uploadStorage = createUploadStorage(config.UPLOAD_ROOT);
  await uploadStorage.ensureRoot();
  await uploadStorage.reconcileOrphans(await createImportRepository(pool).listStorageKeys());
  const reportStorage = createUploadStorage(config.REPORT_ROOT);
  await reportStorage.ensureRoot();
  await reportStorage.reconcileOrphans(await createImportRepository(pool).listReportKeys());
  await app.listen({ host: config.HOST, port: config.PORT });
  worker = startWorkerSupervisor(app.log);
  app.log.info({ host: config.HOST, port: config.PORT }, "service started");
} catch (error: unknown) {
  app.log.error({ err: error }, "service failed to start");
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
}
