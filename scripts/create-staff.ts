import { resolve } from "node:path";

import { loadConfig } from "../src/config.js";
import { parseBootstrapEnvironment } from "../src/auth/bootstrap.js";
import { createAuthRepository } from "../src/auth/repository.js";
import { createPasswordService } from "../src/auth/passwords.js";
import { createPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";

const config = loadConfig();
const bootstrap = parseBootstrapEnvironment(process.env);
void bootstrap.STAFF_BOOTSTRAP_SECRET;
const pool = createPool(config);

try {
  await runMigrations(pool, resolve(process.env.MIGRATIONS_DIR ?? "migrations"));
  const passwordService = createPasswordService();
  const repository = createAuthRepository(pool);
  const user = await repository.createStaff({
    email: bootstrap.STAFF_EMAIL.trim().toLowerCase(),
    passwordHash: await passwordService.hash(bootstrap.STAFF_PASSWORD)
  });
  console.log(`Created platform staff user ${user.email} (${user.id})`);
} finally {
  await pool.end();
}
