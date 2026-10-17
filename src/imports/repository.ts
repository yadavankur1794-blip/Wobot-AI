import type { QueryResultRow } from "pg";

import type { DatabaseClient, DatabasePool } from "../db/types.js";
import type { UserRole } from "../auth/types.js";

export interface ImportSummary {
  id: string;
  merchantId: string;
  originalFilename: string;
  storageKey: string;
  contentHash: Buffer;
  fileSizeBytes: string;
  inputEncoding: string;
  reportKey: string | null;
  status: string;
  cancelRequested: boolean;
  scannedRows: string;
  validRows: string;
  rejectedRows: string;
  distinctProducts: string;
  publishedRows: string;
  createdAt: Date;
  updatedAt: Date;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  attempt: string;
  leaseOwner: string | null;
}

interface ImportRow extends QueryResultRow {
  id: string;
  merchant_id: string;
  original_filename: string | null;
  storage_path: string;
  content_sha256: Buffer;
  file_size_bytes: string;
  input_encoding: string;
  report_path: string | null;
  status: string;
  cancel_requested: boolean;
  scanned_rows: string;
  valid_rows: string;
  rejected_rows: string;
  distinct_products: string;
  published_rows: string;
  created_at: Date;
  updated_at: Date;
  error_code: string | null;
  error_message: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  attempt: string;
  lease_owner: string | null;
}

export interface ImportRegistration {
  duplicate: boolean;
  import: ImportSummary;
}

export interface CreateImportInput {
  merchantId: string;
  originalFilename: string;
  storageKey: string;
  contentHash: Buffer;
  fileSizeBytes: number;
  inputEncoding: "utf8" | "utf16le" | "windows-1252";
}

export interface ImportRepository {
  createImport(input: CreateImportInput): Promise<ImportRegistration>;
  findVisibleImport(importId: string, actor: { role: UserRole; merchantId: string | null }): Promise<ImportSummary | null>;
  listStorageKeys(): Promise<ReadonlySet<string>>;
  listReportKeys(): Promise<ReadonlySet<string>>;
  claimNextQueued(ownerId: string): Promise<ImportSummary | null>;
  claimNextReady(ownerId: string): Promise<ImportSummary | null>;
  reclaimExpired(ownerId: string): Promise<number>;
  checkLease(importId: string, ownerId: string, attempt: string): Promise<"ACTIVE" | "CANCEL_REQUESTED" | "LOST">;
  completeCancellation(importId: string, ownerId: string, attempt: string): Promise<boolean>;
  cancelImport(importId: string, actor: { role: UserRole; merchantId: string | null }): Promise<"CANCELLED" | "REQUESTED" | "ALREADY_CANCELLED" | "NOT_FOUND" | "IN_PROGRESS" | "TERMINAL">;
  updateProgress(importId: string, counters: {
    scannedRows: number;
    validRows: number;
    rejectedRows: number;
    distinctProducts: number;
  }, ownerId?: string, attempt?: string): Promise<void>;
  markReady(importId: string, reportKey: string, ownerId: string): Promise<void>;
  markFailed(importId: string, code: string, message: string, reportKey?: string, ownerId?: string, attempt?: string): Promise<void>;
  stageBatch(importId: string, rows: readonly StagedProduct[], ownerId?: string, attempt?: string): Promise<void>;
  countStaged(importId: string): Promise<number>;
}

export interface StagedProduct {
  merchantId: string;
  sku: string;
  name: string;
  category: string;
  price: string;
  currency: string;
  stock: string;
  updatedAt: Date;
  sourceRow: number;
  sourceLineStart?: number;
  sourceLineEnd?: number;
}

const importColumns = `
  id, merchant_id, original_filename, storage_path, content_sha256,
  file_size_bytes, input_encoding, report_path, status, cancel_requested, scanned_rows, valid_rows,
  rejected_rows, distinct_products, published_rows, created_at, updated_at,
  error_code, error_message, started_at, finished_at, attempt, lease_owner`;

function mapImport(row: ImportRow): ImportSummary {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    originalFilename: row.original_filename ?? "",
    storageKey: row.storage_path,
    contentHash: row.content_sha256,
    fileSizeBytes: row.file_size_bytes,
    inputEncoding: row.input_encoding,
    reportKey: row.report_path,
    status: row.status,
    cancelRequested: row.cancel_requested,
    scannedRows: row.scanned_rows,
    validRows: row.valid_rows,
    rejectedRows: row.rejected_rows,
    distinctProducts: row.distinct_products,
    publishedRows: row.published_rows,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at
    ,attempt: row.attempt,
    leaseOwner: row.lease_owner
  };
}

const MAX_IMPORT_REGISTRATION_ATTEMPTS = 3;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

async function findActiveByHash(client: DatabaseClient, merchantId: string, contentHash: Buffer): Promise<ImportSummary | null> {
  const result = await client.query<ImportRow>(
    `SELECT ${importColumns}
     FROM imports
     WHERE merchant_id = $1 AND content_sha256 = $2
       AND status NOT IN ('FAILED', 'CANCELLED')
     ORDER BY import_order DESC
     LIMIT 1`,
    [merchantId, contentHash]
  );
  const row = result.rows[0];
  return row ? mapImport(row) : null;
}

export function createImportRepository(pool: DatabasePool): ImportRepository {
  return {
    async createImport(input) {
      for (let registrationAttempt = 1; registrationAttempt <= MAX_IMPORT_REGISTRATION_ATTEMPTS; registrationAttempt += 1) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const inserted = await client.query<ImportRow>(
            `INSERT INTO imports
               (merchant_id, content_sha256, original_filename, storage_path, file_size_bytes, input_encoding, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'QUEUED')
             ON CONFLICT DO NOTHING
             RETURNING ${importColumns}`,
            [input.merchantId, input.contentHash, input.originalFilename, input.storageKey, input.fileSizeBytes, input.inputEncoding]
          );
          if (inserted.rows[0]) {
            await client.query("COMMIT");
            return { duplicate: false, import: mapImport(inserted.rows[0]) };
          }

          const existing = await findActiveByHash(client, input.merchantId, input.contentHash);
          if (existing) {
            await client.query("COMMIT");
            return { duplicate: true, import: existing };
          }

          // A conflicting row may have become terminal before the snapshot
          // lookup. Start a fresh transaction and retry the insert.
          await client.query("ROLLBACK");
        } catch (error: unknown) {
          await client.query("ROLLBACK").catch(() => undefined);
          if (isUniqueViolation(error) && registrationAttempt < MAX_IMPORT_REGISTRATION_ATTEMPTS) {
            continue;
          }
          throw error;
        } finally {
          client.release();
        }
      }
      throw new Error("Import registration conflict did not settle after bounded retries");
    },

    async findVisibleImport(importId, actor) {
      const result = await pool.query<ImportRow>(
        `SELECT ${importColumns}
         FROM imports
         WHERE id = $1
           AND ($2 = 'PLATFORM_STAFF' OR merchant_id = $3)`,
        [importId, actor.role, actor.merchantId]
      );
      const row = result.rows[0];
      return row ? mapImport(row) : null;
    },

    async listStorageKeys() {
      const result = await pool.query<{ storage_path: string }>("SELECT storage_path FROM imports");
      return new Set(result.rows.map((row) => row.storage_path));
    },

    async listReportKeys() {
      const result = await pool.query<{ report_path: string }>("SELECT report_path FROM imports WHERE report_path IS NOT NULL");
      return new Set(result.rows.map((row) => row.report_path));
    },

    async claimNextQueued(ownerId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<ImportRow>(
          `WITH next_job AS (
             SELECT id FROM imports
             WHERE status = 'QUEUED'
             ORDER BY created_at, id
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           )
           UPDATE imports AS i
           SET status = 'VALIDATING', attempt = i.attempt + 1,
               started_at = COALESCE(i.started_at, now()),
               lease_owner = $1, lease_expires_at = now() + interval '30 seconds', updated_at = now(),
               cancel_requested = false, error_code = NULL, error_message = NULL,
               scanned_rows = 0, valid_rows = 0, rejected_rows = 0, distinct_products = 0, published_rows = 0
           FROM next_job
           WHERE i.id = next_job.id
           RETURNING i.id, i.merchant_id, i.original_filename, i.storage_path, i.content_sha256,
                     i.file_size_bytes, i.input_encoding, i.report_path, i.status, i.cancel_requested,
                     i.scanned_rows, i.valid_rows, i.rejected_rows, i.distinct_products,
                     i.published_rows, i.created_at, i.updated_at, i.error_code, i.error_message,
                     i.started_at, i.finished_at, i.attempt, i.lease_owner`
          , [ownerId]);
        await client.query("COMMIT");
        return result.rows[0] ? mapImport(result.rows[0]) : null;
      } catch (error: unknown) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async updateProgress(importId, counters, ownerId, attempt) {
      await pool.query(
        `UPDATE imports
         SET scanned_rows = $2, valid_rows = $3, rejected_rows = $4,
             distinct_products = $5, updated_at = now(), lease_expires_at = CASE WHEN $6::text IS NULL THEN lease_expires_at ELSE now() + interval '30 seconds' END
         WHERE id = $1 AND status = 'VALIDATING'
           AND ($6::text IS NULL OR (lease_owner = $6 AND attempt = $7))`,
        [importId, counters.scannedRows, counters.validRows, counters.rejectedRows, counters.distinctProducts, ownerId ?? null, attempt ?? null]
      );
    },

    async reclaimExpired(ownerId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<{ id: string }>(
          `WITH expired AS (
             SELECT id, status FROM imports
             WHERE lease_expires_at < now()
               AND status IN ('VALIDATING', 'CANCEL_REQUESTED', 'READY_TO_APPLY', 'APPLYING')
             FOR UPDATE SKIP LOCKED
           )
           UPDATE imports AS i
           SET status = CASE
                 WHEN expired.status = 'VALIDATING' THEN 'QUEUED'
                 WHEN expired.status = 'CANCEL_REQUESTED' THEN 'CANCELLED'
                 ELSE 'READY_TO_APPLY' END,
               attempt = i.attempt + 1,
               lease_owner = CASE WHEN expired.status IN ('VALIDATING', 'CANCEL_REQUESTED') THEN NULL ELSE $1 END,
               lease_expires_at = CASE WHEN expired.status IN ('VALIDATING', 'CANCEL_REQUESTED') THEN NULL ELSE now() + interval '30 seconds' END,
               cancel_requested = false,
               report_path = CASE WHEN expired.status IN ('VALIDATING', 'CANCEL_REQUESTED') THEN NULL ELSE i.report_path END,
               scanned_rows = CASE WHEN expired.status IN ('VALIDATING', 'CANCEL_REQUESTED') THEN 0 ELSE i.scanned_rows END,
               valid_rows = CASE WHEN expired.status IN ('VALIDATING', 'CANCEL_REQUESTED') THEN 0 ELSE i.valid_rows END,
               rejected_rows = CASE WHEN expired.status IN ('VALIDATING', 'CANCEL_REQUESTED') THEN 0 ELSE i.rejected_rows END,
               distinct_products = CASE WHEN expired.status IN ('VALIDATING', 'CANCEL_REQUESTED') THEN 0 ELSE i.distinct_products END,
               published_rows = CASE WHEN expired.status = 'APPLYING' THEN 0 ELSE i.published_rows END,
               updated_at = now()
           FROM expired WHERE i.id = expired.id RETURNING i.id`, [ownerId]
        );
        await client.query(
          `DELETE FROM import_staging WHERE import_id IN
           (SELECT id FROM imports WHERE status IN ('QUEUED', 'CANCELLED') AND lease_owner IS NULL AND attempt > 0)`
        );
        await client.query("COMMIT");
        return result.rowCount ?? 0;
      } catch (error: unknown) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },

    async checkLease(importId, ownerId, attempt) {
      const result = await pool.query<{ status: string; cancel_requested: boolean }>(
        `SELECT status, cancel_requested FROM imports WHERE id = $1 AND lease_owner = $2 AND attempt = $3`,
        [importId, ownerId, attempt]
      );
      const row = result.rows[0];
      if (!row || !["VALIDATING", "CANCEL_REQUESTED"].includes(row.status)) return "LOST";
      return row.cancel_requested || row.status === "CANCEL_REQUESTED" ? "CANCEL_REQUESTED" : "ACTIVE";
    },

    async completeCancellation(importId, ownerId, attempt) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `UPDATE imports SET status = 'CANCELLED', finished_at = now(), lease_owner = NULL,
             lease_expires_at = NULL, updated_at = now()
           WHERE id = $1 AND status = 'CANCEL_REQUESTED' AND cancel_requested = true
             AND lease_owner = $2 AND attempt = $3`, [importId, ownerId, attempt]
        );
        if ((result.rowCount ?? 0) === 1) await client.query("DELETE FROM import_staging WHERE import_id = $1", [importId]);
        await client.query("COMMIT");
        return (result.rowCount ?? 0) === 1;
      } catch (error: unknown) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },

    async cancelImport(importId, actor) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<{ status: string }>(
          `SELECT status FROM imports WHERE id = $1
           AND ($2 = 'PLATFORM_STAFF' OR merchant_id = $3) FOR UPDATE`,
          [importId, actor.role, actor.merchantId]
        );
        const row = result.rows[0];
        if (!row) { await client.query("ROLLBACK"); return "NOT_FOUND"; }
        let outcome: "CANCELLED" | "REQUESTED" | "ALREADY_CANCELLED" | "IN_PROGRESS" | "TERMINAL";
        if (row.status === "QUEUED" || row.status === "READY_TO_APPLY") {
          await client.query("DELETE FROM import_staging WHERE import_id = $1", [importId]);
          await client.query(`UPDATE imports SET status = 'CANCELLED', cancel_requested = true,
            finished_at = now(), lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE id = $1`, [importId]);
          outcome = "CANCELLED";
        } else if (row.status === "VALIDATING") {
          await client.query("UPDATE imports SET status = 'CANCEL_REQUESTED', cancel_requested = true, updated_at = now() WHERE id = $1", [importId]);
          outcome = "REQUESTED";
        } else if (row.status === "CANCEL_REQUESTED") outcome = "REQUESTED";
        else if (row.status === "CANCELLED") outcome = "ALREADY_CANCELLED";
        else if (row.status === "APPLYING") outcome = "IN_PROGRESS";
        else outcome = "TERMINAL";
        await client.query("COMMIT");
        return outcome;
      } catch (error: unknown) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },

    async claimNextReady(ownerId) {
      const result = await pool.query<ImportRow>(
        `UPDATE imports
         SET status = 'APPLYING', updated_at = now(), lease_expires_at = now() + interval '30 seconds'
         WHERE id = (
           SELECT id FROM imports
           WHERE status = 'READY_TO_APPLY'
             AND cancel_requested = false
             AND lease_owner = $1
           ORDER BY created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING ${importColumns}`,
        [ownerId]
      );
      return result.rows[0] ? mapImport(result.rows[0]) : null;
    },

    async markReady(importId, reportKey, ownerId) {
      await pool.query(
        `UPDATE imports
         SET status = 'READY_TO_APPLY', report_path = $2, finished_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'VALIDATING' AND lease_owner = $3`,
        [importId, reportKey, ownerId]
      );
    },

    async markFailed(importId, code, message, reportKey, ownerId, attempt) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `UPDATE imports
           SET status = 'FAILED', error_code = $2, error_message = $3, report_path = COALESCE($4, report_path),
               finished_at = now(), updated_at = now(), lease_owner = NULL, lease_expires_at = NULL
           WHERE id = $1 AND status IN ('QUEUED', 'VALIDATING')
             AND ($5::text IS NULL OR (lease_owner = $5 AND attempt = $6))`,
          [importId, code, message, reportKey ?? null, ownerId ?? null, attempt ?? null]
        );
        if ((result.rowCount ?? 0) === 1) {
          await client.query("DELETE FROM import_staging WHERE import_id = $1", [importId]);
        }
        await client.query("COMMIT");
      } catch (error: unknown) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async stageBatch(importId, rows, ownerId, attempt) {
      if (rows.length === 0) {
        return;
      }
      const values: unknown[] = [];
      const tuples = rows.map((row, index) => {
        const offset = index * 12;
        values.push(importId, row.merchantId, row.sku, row.name, row.category, row.price, row.currency, row.stock, row.updatedAt, row.sourceRow, row.sourceLineStart ?? null, row.sourceLineEnd ?? null);
        return `(${Array.from({ length: 12 }, (_, parameterIndex) => `$${offset + parameterIndex + 1}`).join(", ")})`;
      });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const lease = await client.query<{ status: string; lease_owner: string | null; attempt: string; cancel_requested: boolean }>(
          "SELECT status, lease_owner, attempt, cancel_requested FROM imports WHERE id = $1 FOR UPDATE", [importId]
        );
        const current = lease.rows[0];
        if (!current || current.status !== "VALIDATING" || (ownerId && (current.lease_owner !== ownerId || current.attempt !== attempt)) || current.cancel_requested) {
          throw new Error("Import worker no longer owns validation");
        }
        await client.query(
        `INSERT INTO import_staging
           (import_id, merchant_id, sku, name, category, price, currency, stock, updated_at, source_row, source_line_start, source_line_end)
         VALUES ${tuples.join(",")}
         ON CONFLICT (import_id, sku) DO UPDATE
         SET merchant_id = EXCLUDED.merchant_id, name = EXCLUDED.name,
             category = EXCLUDED.category, price = EXCLUDED.price,
             currency = EXCLUDED.currency, stock = EXCLUDED.stock,
             updated_at = EXCLUDED.updated_at, source_row = EXCLUDED.source_row
         WHERE (EXCLUDED.updated_at, EXCLUDED.source_row) >
               (import_staging.updated_at, import_staging.source_row)`,
        values
        );
        await client.query("UPDATE imports SET lease_expires_at = now() + interval '30 seconds', updated_at = now() WHERE id = $1", [importId]);
        await client.query("COMMIT");
      } catch (error: unknown) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },

    async countStaged(importId) {
      const result = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM import_staging WHERE import_id = $1",
        [importId]
      );
      return Number(result.rows[0]?.count ?? "0");
    }
  };
}
