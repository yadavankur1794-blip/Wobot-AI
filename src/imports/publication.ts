import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { DatabaseClient, DatabasePool } from "../db/types.js";

const PUBLICATION_BATCH_SIZE = 500;
const TEST_PUBLICATION_BARRIER_DIR = "CSV_TEST_PUBLICATION_BARRIER_DIR";
const TEST_PUBLICATION_BARRIER_TIMEOUT_MS = 60_000;
const TEST_PUBLICATION_BARRIER_REACHED_FILE = "publication-batch-reached";
const TEST_PUBLICATION_BARRIER_RELEASE_FILE = "publication-batch-release";

interface StagedRow {
  merchant_id: string;
  sku: string;
  name: string;
  category: string;
  price: string;
  currency: string;
  stock: string;
  updated_at: Date;
  source_row: string;
  import_order: string;
}

export class PublicationOwnershipError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PublicationOwnershipError";
  }
}

export async function publishImport(
  pool: DatabasePool,
  importId: string,
  ownerId: string,
  attempt?: string,
  hooks?: { afterBatch?: (batchNumber: number) => Promise<void> }
): Promise<number> {
  const client = await pool.connect();
  let publishedRows = 0;
  try {
    await client.query("BEGIN");
    const ownership = await client.query<{
      status: string;
      lease_owner: string | null;
      cancel_requested: boolean;
      published_rows: string;
      attempt: string;
    }>(
      `SELECT status, lease_owner, cancel_requested, published_rows, attempt
       FROM imports WHERE id = $1 FOR UPDATE`,
      [importId]
    );
    const job = ownership.rows[0];
    if (!job || job.status !== "APPLYING" || job.lease_owner !== ownerId || (attempt !== undefined && job.attempt !== attempt)) {
      throw new PublicationOwnershipError("Publication worker no longer owns the import");
    }
    if (job.cancel_requested) {
      throw new PublicationOwnershipError("Import cancellation was requested before publication");
    }

    let lastSku: string | null = null;
    let batchNumber = 0;
    while (true) {
      const staged = await readBatch(client, importId, lastSku);
      if (staged.length === 0) break;
      const affected = await upsertBatch(client, staged);
      publishedRows += affected;
      lastSku = staged[staged.length - 1]!.sku;
      batchNumber += 1;
      if (hooks?.afterBatch) await hooks.afterBatch(batchNumber);
      await waitForTestPublicationBarrier(batchNumber);
      await client.query(
        `UPDATE imports SET published_rows = $2, updated_at = now()
         WHERE id = $1 AND status = 'APPLYING' AND lease_owner = $3
           AND ($4::bigint IS NULL OR attempt = $4)`,
        [importId, publishedRows, ownerId, attempt ?? null]
      );
    }

    const completed = await client.query(
      `UPDATE imports
       SET status = 'COMPLETED', published_rows = $2, finished_at = now(),
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'APPLYING' AND lease_owner = $3
         AND ($4::bigint IS NULL OR attempt = $4)
       RETURNING id`,
      [importId, publishedRows, ownerId, attempt ?? null]
    );
    if (completed.rowCount !== 1) {
      throw new PublicationOwnershipError("Import ownership changed before completion");
    }
    await client.query("COMMIT");
    return publishedRows;
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function waitForTestPublicationBarrier(batchNumber: number): Promise<void> {
  const barrierDirectory = process.env[TEST_PUBLICATION_BARRIER_DIR];
  if (!barrierDirectory || batchNumber !== 1) return;

  const reachedFile = join(barrierDirectory, TEST_PUBLICATION_BARRIER_REACHED_FILE);
  const releaseFile = join(barrierDirectory, TEST_PUBLICATION_BARRIER_RELEASE_FILE);
  await mkdir(barrierDirectory, { recursive: true });
  await writeFile(reachedFile, `batch=${batchNumber}\n`, { encoding: "utf8" });

  const deadline = Date.now() + TEST_PUBLICATION_BARRIER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await access(releaseFile);
      return;
    } catch {
      await delay(50);
    }
  }

  throw new Error("Test-only publication barrier timed out");
}

async function readBatch(client: DatabaseClient, importId: string, lastSku: string | null): Promise<StagedRow[]> {
  const result = await client.query<StagedRow>(
    `SELECT s.merchant_id, s.sku, s.name, s.category, s.price::text, s.currency,
            s.stock::text, s.updated_at, s.source_row::text, i.import_order::text
     FROM import_staging AS s
     JOIN imports AS i ON i.id = s.import_id
     WHERE s.import_id = $1 AND ($2::text IS NULL OR s.sku > $2)
     ORDER BY s.sku
     LIMIT $3`,
    [importId, lastSku, PUBLICATION_BATCH_SIZE]
  );
  return result.rows;
}

async function upsertBatch(client: DatabaseClient, rows: readonly StagedRow[]): Promise<number> {
  const values: unknown[] = [];
  const tuples = rows.map((row, index) => {
    const offset = index * 10;
    values.push(row.merchant_id, row.sku, row.name, row.category, row.price, row.currency, row.stock, row.updated_at, row.import_order, row.source_row);
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`;
  });
  const result = await client.query(
    `INSERT INTO products
       (merchant_id, sku, name, category, price, currency, stock, updated_at, last_import_order, last_source_row)
     VALUES ${tuples.join(",")}
     ON CONFLICT (merchant_id, sku) DO UPDATE
     SET name = EXCLUDED.name, category = EXCLUDED.category, price = EXCLUDED.price,
         currency = EXCLUDED.currency, stock = EXCLUDED.stock, updated_at = EXCLUDED.updated_at,
         last_import_order = EXCLUDED.last_import_order, last_source_row = EXCLUDED.last_source_row
     WHERE EXCLUDED.updated_at > products.updated_at
        OR (EXCLUDED.updated_at = products.updated_at AND (
          EXCLUDED.last_import_order > products.last_import_order
          OR (EXCLUDED.last_import_order = products.last_import_order
              AND EXCLUDED.last_source_row > products.last_source_row)
        ))
     RETURNING sku`,
    values
  );
  return result.rowCount ?? 0;
}
