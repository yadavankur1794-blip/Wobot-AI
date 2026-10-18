import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { DatabasePool } from "./types.js";

const migrationNamePattern = /^\d+_[a-z0-9_]+\.sql$/;

export async function runMigrations(pool: DatabasePool, migrationsDirectory: string): Promise<void> {
  const migrationFiles = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && migrationNamePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["bulk-csv-ingestion:migrations"]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const appliedResult = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename"
    );
    const applied = new Set(appliedResult.rows.map((row) => row.filename));

    for (const filename of migrationFiles) {
      if (applied.has(filename)) {
        continue;
      }
      const sql = await readFile(join(migrationsDirectory, filename), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [basename(filename)]);
    }

    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
