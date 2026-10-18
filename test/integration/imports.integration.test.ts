import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { FastifyInstance } from "fastify";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createPool } from "../../src/db/pool.js";
import type { DatabasePool } from "../../src/db/types.js";
import { createImportRepository } from "../../src/imports/repository.js";
import { processNextImport } from "../../src/imports/processor.js";
import { publishImport } from "../../src/imports/publication.js";

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("INTEGRATION_DATABASE_URL is required for real PostgreSQL integration tests");
}

const boundary = "phase3-boundary";
const csv = "sku,name,category,price,currency,stock,updated_at\nA,Alpha,Books,10.00,USD,2,2026-01-01T00:00:00Z\n";

function multipart(files: Array<{ filename: string; contents: string }>): { payload: Buffer; contentType: string } {
  const sections = files.flatMap(({ filename, contents }) => [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    "Content-Type: text/csv",
    "",
    contents
  ]);
  const payload = [...sections, `--${boundary}--`, ""].join("\r\n");
  return { payload: Buffer.from(payload), contentType: `multipart/form-data; boundary=${boundary}` };
}

function binaryMultipart(filename: string, contents: Buffer): { payload: Buffer; contentType: string } {
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`, "ascii");
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "ascii");
  return { payload: Buffer.concat([prefix, contents, suffix]), contentType: `multipart/form-data; boundary=${boundary}` };
}

function manyRows(count: number, updatedAt = "2026-01-01T00:00:00Z"): string {
  const rows = ["sku,name,category,price,currency,stock,updated_at"];
  for (let index = 0; index < count; index += 1) rows.push(`SKU-${index},Product ${index},books,10.00,USD,1,${updatedAt}`);
  return `${rows.join("\n")}\n`;
}

async function register(app: FastifyInstance, email: string): Promise<{ token: string; merchantId: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { merchantName: email, email, password: "correct horse battery staple" }
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { token: string; user: { merchantId: string } };
  return { token: body.token, merchantId: body.user.merchantId };
}

let pool: DatabasePool;
let app: FastifyInstance;
let uploadRoot: string;

beforeAll(async () => {
  const config = loadConfig({ ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: "test", LOG_LEVEL: "silent" });
  pool = createPool(config);
  uploadRoot = await mkdtemp(join(tmpdir(), "csv-imports-"));
  await runMigrations(pool, resolve("migrations"));
  app = buildApp({ database: pool, logLevel: "silent", uploadRoot, reportRoot: join(uploadRoot, "reports") });
  await app.ready();
});

beforeEach(async () => {
  await pool.query("TRUNCATE sessions, users, merchants CASCADE");
  const entries = await import("node:fs/promises").then(({ readdir }) => readdir(uploadRoot));
  await Promise.all(entries.map((entry) => rm(join(uploadRoot, entry), { recursive: true, force: true })));
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await rm(uploadRoot, { recursive: true, force: true });
});

describe("durable streaming import registration with real PostgreSQL", () => {
  it("stores a completed upload, returns QUEUED, and scopes status to the merchant", async () => {
    const merchantA = await register(app, "phase3-a@example.com");
    const merchantB = await register(app, "phase3-b@example.com");
    const form = multipart([{ filename: "products.csv", contents: csv }]);
    const uploaded = await app.inject({
      method: "POST",
      url: "/imports",
      headers: { authorization: `Bearer ${merchantA.token}`, "content-type": form.contentType },
      payload: form.payload
    });

    expect(uploaded.statusCode).toBe(202);
    const body = uploaded.json() as { imports: Array<{ id: string; status: string; duplicate: boolean; fileSizeBytes: string }> };
    expect(body.imports[0]).toMatchObject({ status: "QUEUED", duplicate: false, fileSizeBytes: String(Buffer.byteLength(csv)) });

    const status = await app.inject({
      method: "GET",
      url: `/imports/${body.imports[0]?.id}`,
      headers: { authorization: `Bearer ${merchantA.token}` }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().import).not.toHaveProperty("storagePath");

    const denied = await app.inject({
      method: "GET",
      url: `/imports/${body.imports[0]?.id}`,
      headers: { authorization: `Bearer ${merchantB.token}` }
    });
    expect(denied.statusCode).toBe(404);

    const row = await pool.query<{ storage_path: string; file_size_bytes: string }>("SELECT storage_path, file_size_bytes FROM imports");
    expect(row.rows[0]?.storage_path).toMatch(/^[0-9a-f-]{36}\.csv$/);
    expect(await readFile(join(uploadRoot, row.rows[0]!.storage_path), "utf8")).toBe(csv);
  });

  it("deduplicates sequential and concurrent same-merchant uploads, but not other merchants", async () => {
    const merchantA = await register(app, "phase3-dedupe-a@example.com");
    const merchantB = await register(app, "phase3-dedupe-b@example.com");
    const upload = (token: string, contents = csv) => {
      const form = multipart([{ filename: "products.csv", contents }]);
      return app.inject({
        method: "POST",
        url: "/imports",
        headers: { authorization: `Bearer ${token}`, "content-type": form.contentType },
        payload: form.payload
      });
    };

    const first = await upload(merchantA.token);
    const second = await upload(merchantA.token);
    const concurrent = await Promise.all([upload(merchantA.token), upload(merchantA.token)]);
    const otherMerchant = await upload(merchantB.token);

    expect(first.statusCode).toBe(202);
    expect(second.json().imports[0].duplicate).toBe(true);
    expect(new Set(concurrent.map((response) => response.json().imports[0].id)).size).toBe(1);
    expect(otherMerchant.json().imports[0].duplicate).toBe(false);
    const count = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM imports");
    expect(count.rows[0]?.count).toBe("2");
  });

  it("allows identical bytes to be retried after FAILED or CANCELLED while preserving completed dedupe", async () => {
    const merchant = await register(app, "phase2-terminal-retry@example.com");
    const repository = createImportRepository(pool);
    const failedContents = "not,the,required,header\n1,2,3,4\n";
    const failedForm = multipart([{ filename: "failed.csv", contents: failedContents }]);
    const failedUpload = await app.inject({
      method: "POST",
      url: "/imports",
      headers: { authorization: `Bearer ${merchant.token}`, "content-type": failedForm.contentType },
      payload: failedForm.payload
    });
    const failedImportId = failedUpload.json().imports[0].id as string;
    expect(await processNextImport({ repository, uploadRoot, reportRoot: join(uploadRoot, "reports"), ownerId: "terminal-retry-owner" })).toBe(true);
    expect((await pool.query<{ status: string }>("SELECT status FROM imports WHERE id = $1", [failedImportId])).rows[0]?.status).toBe("FAILED");

    const failedRetryForm = multipart([{ filename: "failed-retry.csv", contents: failedContents }]);
    const failedRetry = await app.inject({
      method: "POST",
      url: "/imports",
      headers: { authorization: `Bearer ${merchant.token}`, "content-type": failedRetryForm.contentType },
      payload: failedRetryForm.payload
    });
    expect(failedRetry.statusCode).toBe(202);
    expect(failedRetry.json().imports[0]).toMatchObject({ duplicate: false, status: "QUEUED" });
    expect(failedRetry.json().imports[0].id).not.toBe(failedImportId);

    const cancelledContents = csv;
    const cancelledForm = multipart([{ filename: "cancelled.csv", contents: cancelledContents }]);
    const cancelledUpload = await app.inject({
      method: "POST",
      url: "/imports",
      headers: { authorization: `Bearer ${merchant.token}`, "content-type": cancelledForm.contentType },
      payload: cancelledForm.payload
    });
    const cancelledImportId = cancelledUpload.json().imports[0].id as string;
    expect((await app.inject({ method: "POST", url: `/imports/${cancelledImportId}/cancel`, headers: { authorization: `Bearer ${merchant.token}` } })).statusCode).toBe(200);

    const cancelledRetryForm = multipart([{ filename: "cancelled-retry.csv", contents: cancelledContents }]);
    const cancelledRetry = await app.inject({
      method: "POST",
      url: "/imports",
      headers: { authorization: `Bearer ${merchant.token}`, "content-type": cancelledRetryForm.contentType },
      payload: cancelledRetryForm.payload
    });
    expect(cancelledRetry.json().imports[0]).toMatchObject({ duplicate: false, status: "QUEUED" });
    expect(cancelledRetry.json().imports[0].id).not.toBe(cancelledImportId);

    await app.inject({ method: "POST", url: `/imports/${failedRetry.json().imports[0].id}/cancel`, headers: { authorization: `Bearer ${merchant.token}` } });
    await app.inject({ method: "POST", url: `/imports/${cancelledRetry.json().imports[0].id}/cancel`, headers: { authorization: `Bearer ${merchant.token}` } });

    const completedForm = multipart([{ filename: "completed.csv", contents: csv }]);
    const completedUpload = await app.inject({
      method: "POST",
      url: "/imports",
      headers: { authorization: `Bearer ${merchant.token}`, "content-type": completedForm.contentType },
      payload: completedForm.payload
    });
    const completedImportId = completedUpload.json().imports[0].id as string;
    expect(await processNextImport({ repository, uploadRoot, reportRoot: join(uploadRoot, "reports"), ownerId: "terminal-retry-owner" })).toBe(true);
    expect(await processNextImport({ repository, pool, uploadRoot, reportRoot: join(uploadRoot, "reports"), ownerId: "terminal-retry-owner" })).toBe(true);
    const completedRetryForm = multipart([{ filename: "completed-retry.csv", contents: csv }]);
    const completedRetry = await app.inject({
      method: "POST",
      url: "/imports",
      headers: { authorization: `Bearer ${merchant.token}`, "content-type": completedRetryForm.contentType },
      payload: completedRetryForm.payload
    });
    expect(completedRetry.json().imports[0]).toMatchObject({ duplicate: true, id: completedImportId, status: "COMPLETED" });
  });

  it("registers multiple files from one multipart request", async () => {
    const merchant = await register(app, "phase3-multiple@example.com");
    const form = multipart([
      { filename: "first.csv", contents: csv },
      { filename: "second.csv", contents: `${csv}B,Beta,Books,11.00,USD,3,2026-01-02T00:00:00Z\n` }
    ]);
    const response = await app.inject({
      method: "POST",
      url: "/imports",
      headers: { authorization: `Bearer ${merchant.token}`, "content-type": form.contentType },
      payload: form.payload
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().imports).toHaveLength(2);
  });

  it("streams validation into PostgreSQL staging and exposes an isolated rejection report", async () => {
    const merchantA = await register(app, "phase3-processing-a@example.com");
    const merchantB = await register(app, "phase3-processing-b@example.com");
    const invalidThenValid = [
      "name,updated_at,sku,category,currency,price,stock",
      '"Broken price",2026-01-01T00:00:00Z,BAD,books,USD,N/A,1',
      '"Desk Lamp\n(adjustable)",2026-01-02T00:00:00+05:30,GOOD,lighting,JPY,100,0'
    ].join("\n") + "\n";
    const form = multipart([{ filename: "catalog.csv", contents: invalidThenValid }]);
    const uploaded = await app.inject({
      method: "POST",
      url: "/imports",
      headers: { authorization: `Bearer ${merchantA.token}`, "content-type": form.contentType },
      payload: form.payload
    });
    const importId = uploaded.json().imports[0].id as string;
    const repository = createImportRepository(pool);
    expect(await processNextImport({ repository, uploadRoot, reportRoot: join(uploadRoot, "reports") })).toBe(true);

    const status = await app.inject({ method: "GET", url: `/imports/${importId}`, headers: { authorization: `Bearer ${merchantA.token}` } });
    expect(status.json().import).toMatchObject({ status: "READY_TO_APPLY", counters: { scannedRows: "2", validRows: "1", rejectedRows: "1", distinctProducts: "1" } });
    const staged = await pool.query<{ sku: string; price: string; currency: string; stock: string }>("SELECT sku, price::text, currency, stock::text FROM import_staging WHERE import_id = $1", [importId]);
    expect(staged.rows).toEqual([{ sku: "GOOD", price: "100", currency: "JPY", stock: "0" }]);

    const report = await app.inject({ method: "GET", url: `/imports/${importId}/rejections`, headers: { authorization: `Bearer ${merchantA.token}` } });
    expect(report.statusCode).toBe(200);
    expect(report.body).toContain("price");
    expect(report.body).toContain("N/A");
    const denied = await app.inject({ method: "GET", url: `/imports/${importId}/rejections`, headers: { authorization: `Bearer ${merchantB.token}` } });
    expect(denied.statusCode).toBe(404);
    const products = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM products");
    expect(products.rows[0]?.count).toBe("0");
  });

  it("keeps an older valid duplicate when a newer duplicate is invalid", async () => {
    const merchant = await register(app, "phase4-invalid-newest@example.com");
    const rows = ["sku,name,category,price,currency,stock,updated_at", "SAME,Older,books,10.00,USD,1,2026-01-01T00:00:00Z"];
    for (let index = 0; index < 498; index += 1) {
      rows.push(`FILL-${index},Filler ${index},books,10.00,USD,1,2026-01-01T00:00:00Z`);
    }
    rows.push("SAME,Newer but invalid,books,N/A,USD,1,2026-02-01T00:00:00Z");
    const form = multipart([{ filename: "invalid-newest.csv", contents: `${rows.join("\n")}\n` }]);
    const uploaded = await app.inject({
      method: "POST",
      url: "/imports",
      headers: { authorization: `Bearer ${merchant.token}`, "content-type": form.contentType },
      payload: form.payload
    });
    const importId = uploaded.json().imports[0].id as string;
    const repository = createImportRepository(pool);
    const processor = { repository, pool, ownerId: "invalid-newest-owner", uploadRoot, reportRoot: join(uploadRoot, "reports") };
    expect(await processNextImport(processor)).toBe(true);
    expect((await pool.query<{ name: string; source_line_start: string | null; source_line_end: string | null }>("SELECT name, source_line_start::text, source_line_end::text FROM import_staging WHERE import_id = $1 AND sku = 'SAME'", [importId])).rows[0]).toEqual({ name: "Older", source_line_start: "2", source_line_end: "2" });
    const report = await app.inject({ method: "GET", url: `/imports/${importId}/rejections`, headers: { authorization: `Bearer ${merchant.token}` } });
    expect(report.body).toContain("INVALID_PRICE");
    expect(report.body).toContain("Newer but invalid");
    expect(await processNextImport(processor)).toBe(true);
    const product = await pool.query<{ name: string; price: string }>("SELECT name, price::text FROM products WHERE merchant_id = $1 AND sku = 'SAME'", [merchant.merchantId]);
    expect(product.rows[0]).toEqual({ name: "Older", price: "10.00" });
  });

  it("recovers short, extra and multiline records while failing malformed quoting without retained staging", async () => {
    const merchant = await register(app, "phase4-structure@example.com");
    const recoverable = [
      "sku,name,category,price,currency,stock,updated_at",
      "SHORT,Too few,books,10.00,USD,1",
      "EXTRA,Too many,books,10.00,USD,1,2026-01-01T00:00:00Z,unexpected",
      "MULTI,\"Line one",
      "Line two\",books,10.00,USD,1,2026-01-02T00:00:00Z"
    ].join("\n") + "\n";
    const recoverableForm = multipart([{ filename: "recoverable.csv", contents: recoverable }]);
    const recoverableUpload = await app.inject({ method: "POST", url: "/imports", headers: { authorization: `Bearer ${merchant.token}`, "content-type": recoverableForm.contentType }, payload: recoverableForm.payload });
    const recoverableId = recoverableUpload.json().imports[0].id as string;
    const repository = createImportRepository(pool);
    const processor = { repository, pool, ownerId: "structure-owner", uploadRoot, reportRoot: join(uploadRoot, "reports") };
    expect(await processNextImport(processor)).toBe(true);
    const recoverableState = await pool.query<{ status: string; rejected_rows: string; valid_rows: string }>("SELECT status, rejected_rows::text, valid_rows::text FROM imports WHERE id = $1", [recoverableId]);
    expect(recoverableState.rows[0]).toEqual({ status: "READY_TO_APPLY", rejected_rows: "2", valid_rows: "1" });
    const recoverableReport = await app.inject({ method: "GET", url: `/imports/${recoverableId}/rejections`, headers: { authorization: `Bearer ${merchant.token}` } });
    expect(recoverableReport.body).toContain("FIELD_COUNT");
    expect((await pool.query<{ name: string; source_line_start: string; source_line_end: string }>("SELECT name, source_line_start::text, source_line_end::text FROM import_staging WHERE import_id = $1 AND sku = 'MULTI'", [recoverableId])).rows[0]).toEqual({ name: "Line one\nLine two", source_line_start: "4", source_line_end: "5" });
    expect(await processNextImport(processor)).toBe(true);

    const malformed = `${manyRows(500)}BROKEN,"unterminated\n`;
    const malformedForm = multipart([{ filename: "malformed.csv", contents: malformed }]);
    const malformedUpload = await app.inject({ method: "POST", url: "/imports", headers: { authorization: `Bearer ${merchant.token}`, "content-type": malformedForm.contentType }, payload: malformedForm.payload });
    const malformedId = malformedUpload.json().imports[0].id as string;
    expect(await processNextImport(processor)).toBe(true);
    const malformedState = await pool.query<{ status: string; error_code: string; staging: string }>("SELECT status, error_code, (SELECT count(*)::text FROM import_staging WHERE import_id = i.id) AS staging FROM imports i WHERE id = $1", [malformedId]);
    expect(malformedState.rows[0]).toEqual({ status: "FAILED", error_code: "CSV_PARSE_FAILED", staging: "0" });
  });

  it("keeps the newest duplicate SKU across staging batch boundaries", async () => {
    const merchant = await register(app, "phase4-winner@example.com");
    const rows = [
      "sku,name,category,price,currency,stock,updated_at",
      "DUP,Newest,books,10.00,USD,1,2026-03-01T00:00:00Z"
    ];
    for (let index = 1; index < 500; index += 1) {
      rows.push(`SKU-${index},Product ${index},books,10.00,USD,1,2026-01-01T00:00:00Z`);
    }
    rows.push("DUP,Older,books,9.00,USD,2,2025-03-01T00:00:00Z");
    const form = multipart([{ filename: "duplicates.csv", contents: `${rows.join("\n")}\n` }]);
    const uploaded = await app.inject({
      method: "POST",
      url: "/imports",
      headers: { authorization: `Bearer ${merchant.token}`, "content-type": form.contentType },
      payload: form.payload
    });
    const importId = uploaded.json().imports[0].id as string;
    expect(await processNextImport({ repository: createImportRepository(pool), uploadRoot, reportRoot: join(uploadRoot, "reports") })).toBe(true);
    const winner = await pool.query<{ name: string; price: string; source_row: string }>(
      "SELECT name, price::text, source_row::text FROM import_staging WHERE import_id = $1 AND sku = 'DUP'",
      [importId]
    );
    expect(winner.rows[0]).toEqual({ name: "Newest", price: "10.00", source_row: "1" });
  });

  it("publishes staged data atomically and preserves exact values", async () => {
    const merchant = await register(app, "phase5-publish@example.com");
    const content = "sku,name,category,price,currency,stock,updated_at\nABC-100,Original,books,24.99,USD,0,2026-03-01T00:00:00Z\nJPY-1,Japanese,books,100,JPY,9007199254740991,2026-03-01T00:00:00Z\n";
    const form = multipart([{ filename: "publish.csv", contents: content }]);
    const uploaded = await app.inject({ method: "POST", url: "/imports", headers: { authorization: `Bearer ${merchant.token}`, "content-type": form.contentType }, payload: form.payload });
    const importId = uploaded.json().imports[0].id as string;
    const repository = createImportRepository(pool);
    const processor = { repository, pool, ownerId: "phase5-publish-owner", uploadRoot, reportRoot: join(uploadRoot, "reports") };
    expect(await processNextImport(processor)).toBe(true);
    expect(await processNextImport(processor)).toBe(true);

    const status = await app.inject({ method: "GET", url: `/imports/${importId}`, headers: { authorization: `Bearer ${merchant.token}` } });
    expect(status.json().import).toMatchObject({ status: "COMPLETED", counters: { publishedRows: "2" } });
    const products = await pool.query<{ sku: string; price: string; currency: string; stock: string }>(
      "SELECT sku, price::text, currency, stock::text FROM products WHERE merchant_id = $1 ORDER BY sku",
      [merchant.merchantId]
    );
    expect(products.rows).toEqual([
      { sku: "ABC-100", price: "24.99", currency: "USD", stock: "0" },
      { sku: "JPY-1", price: "100", currency: "JPY", stock: "9007199254740991" }
    ]);
  });

  it("allows a newer correction, rejects an older update, and uses import order for equal timestamps", async () => {
    const merchant = await register(app, "phase5-freshness@example.com");
    const repository = createImportRepository(pool);
    const processor = { repository, pool, ownerId: "phase5-freshness-owner", uploadRoot, reportRoot: join(uploadRoot, "reports") };
    const uploadAndPublish = async (name: string, price: string, timestamp: string): Promise<void> => {
      const form = multipart([{ filename: "same.csv", contents: `sku,name,category,price,currency,stock,updated_at\nSKU-1,${name},books,${price},USD,1,${timestamp}\n` }]);
      const response = await app.inject({ method: "POST", url: "/imports", headers: { authorization: `Bearer ${merchant.token}`, "content-type": form.contentType }, payload: form.payload });
      expect(response.statusCode).toBe(202);
      expect(await processNextImport(processor)).toBe(true);
      expect(await processNextImport(processor)).toBe(true);
    };
    await uploadAndPublish("Newer", "22.50", "2026-03-02T00:00:00Z");
    await uploadAndPublish("Older", "99.99", "2026-03-01T00:00:00Z");
    await uploadAndPublish("Equal timestamp later import", "23.00", "2026-03-02T00:00:00Z");
    const product = await pool.query<{ name: string; price: string; updated_at: Date }>("SELECT name, price::text, updated_at FROM products WHERE merchant_id = $1 AND sku = 'SKU-1'", [merchant.merchantId]);
    expect(product.rows[0]).toMatchObject({ name: "Equal timestamp later import", price: "23.00" });
  });

  it("rejects unauthenticated upload requests", async () => {
    const form = multipart([{ filename: "products.csv", contents: csv }]);
    const response = await app.inject({ method: "POST", url: "/imports", headers: { "content-type": form.contentType }, payload: form.payload });
    expect(response.statusCode).toBe(401);
  });

  it("cancels a queued import without exposing it to another merchant", async () => {
    const merchantA = await register(app, "phase6-cancel-a@example.com");
    const merchantB = await register(app, "phase6-cancel-b@example.com");
    const form = multipart([{ filename: "cancel.csv", contents: csv }]);
    const uploaded = await app.inject({ method: "POST", url: "/imports", headers: { authorization: `Bearer ${merchantA.token}`, "content-type": form.contentType }, payload: form.payload });
    const importId = uploaded.json().imports[0].id as string;
    const denied = await app.inject({ method: "POST", url: `/imports/${importId}/cancel`, headers: { authorization: `Bearer ${merchantB.token}` } });
    expect(denied.statusCode).toBe(404);
    const cancelled = await app.inject({ method: "POST", url: `/imports/${importId}/cancel`, headers: { authorization: `Bearer ${merchantA.token}` } });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ importId, status: "CANCELLED" });
    const status = await app.inject({ method: "GET", url: `/imports/${importId}`, headers: { authorization: `Bearer ${merchantA.token}` } });
    expect(status.json().import.status).toBe("CANCELLED");
  });

  it("reclaims expired validation leases and fences the stale owner", async () => {
    const merchant = await register(app, "phase6-fencing@example.com");
    const form = multipart([{ filename: "fencing.csv", contents: csv }]);
    const uploaded = await app.inject({ method: "POST", url: "/imports", headers: { authorization: `Bearer ${merchant.token}`, "content-type": form.contentType }, payload: form.payload });
    const importId = uploaded.json().imports[0].id as string;
    const repository = createImportRepository(pool);
    const first = await repository.claimNextQueued("old-owner");
    expect(first?.id).toBe(importId);
    await pool.query("UPDATE imports SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [importId]);
    expect(await repository.reclaimExpired("new-owner")).toBe(1);
    await expect(repository.stageBatch(importId, [{ merchantId: merchant.merchantId, sku: "STALE", name: "stale", category: "x", price: "1", currency: "USD", stock: "1", updatedAt: new Date(), sourceRow: 1 }], "old-owner", first!.attempt)).rejects.toThrow("no longer owns");
    const second = await repository.claimNextQueued("new-owner");
    expect(second?.id).toBe(importId);
    expect(second?.attempt).not.toBe(first?.attempt);
  });

  it("rolls back every publication batch after a real PostgreSQL failure and recovers", async () => {
    const merchant = await register(app, "phase6-rollback@example.com");
    const repository = createImportRepository(pool);
    const processor = { repository, pool, ownerId: "rollback-owner", uploadRoot, reportRoot: join(uploadRoot, "reports") };
    await app.inject({ method: "POST", url: "/imports", headers: { authorization: `Bearer ${merchant.token}`, "content-type": multipart([{ filename: "committed.csv", contents: csv }]).contentType }, payload: multipart([{ filename: "committed.csv", contents: csv }]).payload });
    expect(await processNextImport(processor)).toBe(true);
    expect(await processNextImport(processor)).toBe(true);
    const committedProduct = await pool.query("SELECT name FROM products WHERE merchant_id = $1 AND sku = 'A'", [merchant.merchantId]);
    expect(committedProduct.rows[0]?.name).toBe("Alpha");

    const uploaded = await app.inject({ method: "POST", url: "/imports", headers: { authorization: `Bearer ${merchant.token}`, "content-type": multipart([{ filename: "rollback.csv", contents: manyRows(1001) }]).contentType }, payload: multipart([{ filename: "rollback.csv", contents: manyRows(1001) }]).payload });
    const importId = uploaded.json().imports[0].id as string;
    expect(await processNextImport(processor)).toBe(true);
    const ready = await repository.claimNextReady("rollback-owner");
    expect(ready?.id).toBe(importId);
    await expect(publishImport(pool, importId, "rollback-owner", ready!.attempt, { afterBatch: async (batch) => { if (batch === 1) throw new Error("controlled publication failure"); } })).rejects.toThrow("controlled publication failure");
    const afterFailure = await pool.query<{ status: string; count: string }>("SELECT i.status, count(p.sku)::text AS count FROM imports i LEFT JOIN products p ON p.merchant_id = i.merchant_id WHERE i.id = $1 GROUP BY i.status", [importId]);
    expect(afterFailure.rows[0]).toMatchObject({ status: "APPLYING", count: "1" });
    const stagedProducts = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM products WHERE merchant_id = $1 AND sku LIKE 'SKU-%'", [merchant.merchantId]);
    expect(stagedProducts.rows[0]?.count).toBe("0");
    await pool.query("UPDATE imports SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [importId]);
    expect(await repository.reclaimExpired("recovery-owner")).toBe(1);
    const recovered = await repository.claimNextReady("recovery-owner");
    expect(recovered?.id).toBe(importId);
    await publishImport(pool, importId, "recovery-owner", recovered!.attempt);
    const completed = await pool.query<{ status: string; count: string }>("SELECT i.status, count(p.sku)::text AS count FROM imports i JOIN products p ON p.merchant_id = i.merchant_id WHERE i.id = $1 GROUP BY i.status", [importId]);
    expect(completed.rows[0]).toMatchObject({ status: "COMPLETED", count: "1002" });
  });

  it("cancels active validation at a deterministic checkpoint and cleans staging", async () => {
    const merchant = await register(app, "phase6-active-cancel@example.com");
    const form = multipart([{ filename: "active-cancel.csv", contents: manyRows(2000) }]);
    const uploaded = await app.inject({ method: "POST", url: "/imports", headers: { authorization: `Bearer ${merchant.token}`, "content-type": form.contentType }, payload: form.payload });
    const importId = uploaded.json().imports[0].id as string;
    let releaseCheckpoint: () => void = () => undefined;
    const checkpoint = new Promise<void>((resolveCheckpoint) => { releaseCheckpoint = resolveCheckpoint; });
    const processing = processNextImport({ repository: createImportRepository(pool), uploadRoot, reportRoot: join(uploadRoot, "reports"), ownerId: "cancel-owner", onCheckpoint: () => checkpoint });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = await pool.query<{ status: string }>("SELECT status FROM imports WHERE id = $1", [importId]);
      if (state.rows[0]?.status === "VALIDATING") break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    const cancellation = await app.inject({ method: "POST", url: `/imports/${importId}/cancel`, headers: { authorization: `Bearer ${merchant.token}` } });
    expect(cancellation.statusCode).toBe(202);
    releaseCheckpoint();
    await processing;
    const state = await pool.query<{ status: string; staging: string; products: string }>("SELECT i.status, (SELECT count(*) FROM import_staging WHERE import_id = i.id)::text AS staging, (SELECT count(*) FROM products WHERE merchant_id = i.merchant_id)::text AS products FROM imports i WHERE i.id = $1", [importId]);
    expect(state.rows[0]).toEqual({ status: "CANCELLED", staging: "0", products: "0" });
  });

  it("publishes overlapping imports concurrently with PostgreSQL freshness ordering", async () => {
    const merchant = await register(app, "phase6-overlap@example.com");
    const repository = createImportRepository(pool);
    const upload = async (filename: string, contents: string): Promise<string> => {
      const form = multipart([{ filename, contents }]);
      const response = await app.inject({ method: "POST", url: "/imports", headers: { authorization: `Bearer ${merchant.token}`, "content-type": form.contentType }, payload: form.payload });
      return response.json().imports[0].id as string;
    };
    const older = await upload("older.csv", "sku,name,category,price,currency,stock,updated_at\nSAME,Older,books,10.00,USD,1,2026-01-01T00:00:00Z\n");
    const newer = await upload("newer.csv", "sku,name,category,price,currency,stock,updated_at\nSAME,Newer,books,20.00,USD,1,2026-02-01T00:00:00Z\n");
    const processor = { repository, ownerId: "overlap-owner", uploadRoot, reportRoot: join(uploadRoot, "reports") };
    expect(await processNextImport(processor)).toBe(true);
    expect(await processNextImport(processor)).toBe(true);
    const olderReady = await repository.claimNextReady("overlap-owner");
    const newerReady = await repository.claimNextReady("overlap-owner");
    expect(olderReady?.id).toBe(older);
    expect(newerReady?.id).toBe(newer);
    await Promise.all([
      publishImport(pool, newer, "overlap-owner", newerReady!.attempt),
      publishImport(pool, older, "overlap-owner", olderReady!.attempt)
    ]);
    const product = await pool.query<{ name: string; price: string }>("SELECT name, price::text FROM products WHERE merchant_id = $1 AND sku = 'SAME'", [merchant.merchantId]);
    expect(product.rows[0]).toEqual({ name: "Newer", price: "20.00" });
  });

  it("decodes and publishes a Windows-1252 product name through PostgreSQL", async () => {
    const merchant = await register(app, "phase6-1252@example.com");
    const contents = Buffer.from("sku,name,category,price,currency,stock,updated_at\nCAFE,Caf\xe9,drinks,3.50,USD,1,2026-01-01T00:00:00Z\n", "latin1");
    const form = binaryMultipart("windows-1252.csv", contents);
    const uploaded = await app.inject({ method: "POST", url: "/imports?encoding=windows-1252", headers: { authorization: `Bearer ${merchant.token}`, "content-type": form.contentType }, payload: form.payload });
    const processor = { repository: createImportRepository(pool), pool, ownerId: "1252-owner", uploadRoot, reportRoot: join(uploadRoot, "reports") };
    expect(await processNextImport(processor)).toBe(true);
    expect(await processNextImport(processor)).toBe(true);
    const importId = uploaded.json().imports[0].id as string;
    const result = await pool.query<{ status: string; name: string }>("SELECT i.status, p.name FROM imports i JOIN products p ON p.merchant_id = i.merchant_id WHERE i.id = $1 AND p.sku = 'CAFE'", [importId]);
    expect(result.rows[0]).toEqual({ status: "COMPLETED", name: "Café" });
  });

  it("serializes cancellation at publication and keeps terminal states truthful", async () => {
    const merchant = await register(app, "phase6-cancel-race@example.com");
    const repository = createImportRepository(pool);
    const form = multipart([{ filename: "race.csv", contents: csv }]);
    const uploaded = await app.inject({ method: "POST", url: "/imports", headers: { authorization: `Bearer ${merchant.token}`, "content-type": form.contentType }, payload: form.payload });
    const importId = uploaded.json().imports[0].id as string;
    const processor = { repository, ownerId: "cancel-race-owner", uploadRoot, reportRoot: join(uploadRoot, "reports") };
    expect(await processNextImport(processor)).toBe(true);
    const ready = await Promise.all([
      app.inject({ method: "POST", url: `/imports/${importId}/cancel`, headers: { authorization: `Bearer ${merchant.token}` } }),
      repository.claimNextReady("cancel-race-owner")
    ]);
    const cancellationResponse = ready[0];
    const claimed = ready[1];
    if (claimed) {
      expect(cancellationResponse.statusCode).toBe(409);
      await publishImport(pool, importId, "cancel-race-owner", claimed.attempt);
      const repeated = await app.inject({ method: "POST", url: `/imports/${importId}/cancel`, headers: { authorization: `Bearer ${merchant.token}` } });
      expect(repeated.statusCode).toBe(409);
      expect((await app.inject({ method: "GET", url: `/imports/${importId}`, headers: { authorization: `Bearer ${merchant.token}` } })).json().import.status).toBe("COMPLETED");
    } else {
      expect(cancellationResponse.statusCode).toBe(200);
      expect((await pool.query("SELECT count(*)::text AS count FROM products WHERE merchant_id = $1", [merchant.merchantId])).rows[0]?.count).toBe("0");
    }
  });
});
