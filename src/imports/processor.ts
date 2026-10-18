import { createReadStream } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse";

import {
  MAX_CSV_RECORD_BYTES,
  PROCESSOR_POLL_MS,
  PROGRESS_UPDATE_ROWS,
  STAGING_BATCH_SIZE
} from "./constants.js";
import { DecodeError, EncodingTransform, type InputEncoding } from "./decoder.js";
import { createRejectionReport } from "./rejection-report.js";
import type { ImportRepository, StagedProduct } from "./repository.js";
import type { DatabasePool } from "../db/types.js";
import { publishImport } from "./publication.js";
import { REQUIRED_COLUMNS, validateHeader, validateProduct, type RequiredColumn } from "./validation.js";

interface ParsedRecord {
  record: string[];
  raw: string;
  info: { lines: number };
}

export interface ImportProcessorDependencies {
  repository: ImportRepository;
  pool?: DatabasePool;
  uploadRoot: string;
  reportRoot: string;
  ownerId?: string;
  onCheckpoint?: () => Promise<void>;
}

function compareCandidate(left: StagedProduct, right: StagedProduct): number {
  const time = left.updatedAt.getTime() - right.updatedAt.getTime();
  return time !== 0 ? time : left.sourceRow - right.sourceRow;
}

function processingErrorCode(error: unknown): string {
  if (error instanceof DecodeError) return "INPUT_ENCODING_FAILED";
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    if (error.code === "INVALID_HEADER") return error.code;
    if (error.code.startsWith("CSV_")) return "CSV_PARSE_FAILED";
  }
  return "IMPORT_VALIDATION_FAILED";
}

export async function processNextImport(dependencies: ImportProcessorDependencies): Promise<boolean> {
  const ownerId = dependencies.ownerId ?? "phase4-test-processor";
  const readyImport = dependencies.pool ? await dependencies.repository.claimNextReady(ownerId) : null;
  if (readyImport && dependencies.pool) {
    await publishImport(dependencies.pool, readyImport.id, ownerId, readyImport.attempt);
    return true;
  }
  const job = await dependencies.repository.claimNextQueued(ownerId);
  if (!job) return false;
  const report = await createRejectionReport(dependencies.reportRoot);
  let reportFinished = false;
  try {
    const source = createReadStream(join(dependencies.uploadRoot, job.storageKey), { highWaterMark: 64 * 1024 });
    const decoder = new EncodingTransform(job.inputEncoding as InputEncoding);
    const parser = parse({
      bom: false,
      columns: false,
      encoding: "utf8",
      info: true,
      raw: true,
      relax_column_count: true,
      max_record_size: MAX_CSV_RECORD_BYTES,
      skip_empty_lines: false,
      record_delimiter: ["\n", "\r\n", "\r"]
    });
    source.pipe(decoder).pipe(parser);
    let headerIndexes: Record<RequiredColumn, number> | null = null;
    let scannedRows = 0;
    let validRows = 0;
    let rejectedRows = 0;
    // The exact staged-product count is deliberately refreshed only after the
    // complete source has been staged. Counting import_staging during the
    // 500-row progress loop performs a full-table scan and is not safe to
    // approximate from the in-memory batch: duplicate winners can replace
    // existing rows, and retries/reclaims can roll staging back.
    let distinctProducts = Number(job.distinctProducts);
    let previousLine = 0;
    const batch = new Map<string, StagedProduct>();

    const flush = async (): Promise<void> => {
      if (batch.size === 0) return;
      await dependencies.repository.stageBatch(job.id, [...batch.values()], ownerId, job.attempt);
      batch.clear();
      await dependencies.repository.updateProgress(job.id, {
        scannedRows,
        validRows,
        rejectedRows,
        distinctProducts
      }, ownerId, job.attempt);
    };

    for await (const item of parser as AsyncIterable<ParsedRecord>) {
      const record = item.record;
      const lineEnd = item.info.lines;
      if (!headerIndexes) {
        const header = validateHeader(record);
        if ("field" in header) {
          const error = new Error(header.reason) as Error & { code: string };
          error.code = header.code;
          throw error;
        }
        headerIndexes = header.indexes;
        previousLine = lineEnd;
        continue;
      }
      scannedRows += 1;
      if (scannedRows % PROGRESS_UPDATE_ROWS === 0) {
        if (dependencies.onCheckpoint) await dependencies.onCheckpoint();
        const lease = await dependencies.repository.checkLease(job.id, ownerId, job.attempt);
        if (lease === "CANCEL_REQUESTED") {
          await report.abort();
          await dependencies.repository.completeCancellation(job.id, ownerId, job.attempt);
          return true;
        }
        if (lease === "LOST") throw new Error("Import worker no longer owns validation");
      }
      const lineStart = previousLine + 1;
      previousLine = lineEnd;
      if (record.length !== REQUIRED_COLUMNS.length) {
        rejectedRows += 1;
        await report.reject({
          ordinal: scannedRows,
          lineStart,
          lineEnd,
          field: "record",
          reason: `Expected ${REQUIRED_COLUMNS.length} fields but received ${record.length}`,
          code: "FIELD_COUNT",
          fields: record,
          rawRecord: item.raw
        });
      } else {
        const result = validateProduct(record, headerIndexes);
        if ("field" in result) {
          rejectedRows += 1;
          await report.reject({
            ordinal: scannedRows,
            lineStart,
            lineEnd,
            field: result.field,
            reason: result.reason,
            code: result.code,
            fields: record,
            rawRecord: item.raw
          });
        } else {
          validRows += 1;
          const candidate: StagedProduct = {
            merchantId: job.merchantId,
            ...result,
            sourceRow: scannedRows,
            sourceLineStart: lineStart,
            sourceLineEnd: lineEnd
          };
          const previous = batch.get(candidate.sku);
          if (!previous || compareCandidate(candidate, previous) > 0) batch.set(candidate.sku, candidate);
          if (batch.size >= STAGING_BATCH_SIZE) await flush();
        }
      }
      if (scannedRows % PROGRESS_UPDATE_ROWS === 0) {
        await dependencies.repository.updateProgress(job.id, {
          scannedRows,
          validRows,
          rejectedRows,
          distinctProducts
        }, ownerId, job.attempt);
      }
    }
    if (!headerIndexes) throw new Error("CSV file is missing a header row");
    await flush();
    // This is the authoritative value used for READY_TO_APPLY and later API
    // responses. It runs once, after all in-memory rows have been committed.
    distinctProducts = await countStaged(dependencies.repository, job.id);
    await dependencies.repository.updateProgress(job.id, {
      scannedRows,
      validRows,
      rejectedRows,
      distinctProducts
    }, ownerId, job.attempt);
    const finalLease = await dependencies.repository.checkLease(job.id, ownerId, job.attempt);
    if (finalLease === "CANCEL_REQUESTED") {
      await report.abort();
      await dependencies.repository.completeCancellation(job.id, ownerId, job.attempt);
      return true;
    }
    if (finalLease === "LOST") throw new Error("Import worker no longer owns validation");
    await report.finish();
    reportFinished = true;
    await dependencies.repository.markReady(job.id, report.key, ownerId);
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "CSV processing failed";
    const lease = await dependencies.repository.checkLease(job.id, ownerId, job.attempt).catch(() => "LOST" as const);
    if (lease === "CANCEL_REQUESTED") {
      await report.abort().catch(() => undefined);
      await dependencies.repository.completeCancellation(job.id, ownerId, job.attempt);
      return true;
    }
    await report.finish().catch(() => undefined);
    reportFinished = true;
    await dependencies.repository.markFailed(job.id, processingErrorCode(error), message.slice(0, 500), report.key, ownerId, job.attempt);
    return true;
  } finally {
    if (!reportFinished) {
      // The report writer is finalized in both success and failure paths.
    }
  }
}

async function countStaged(repository: ImportRepository, importId: string): Promise<number> {
  if ("countStaged" in repository && typeof repository.countStaged === "function") {
    return repository.countStaged(importId);
  }
  return 0;
}

export function startImportProcessor(dependencies: ImportProcessorDependencies): { stop(): void } {
  const ownerId = dependencies.ownerId ?? "phase4-test-processor";
  let stopped = false;
  let active = false;
  const tick = async (): Promise<void> => {
    if (stopped || active) return;
    active = true;
    try {
      await dependencies.repository.reclaimExpired(ownerId);
      await processNextImport(dependencies);
    } catch {
      // The next tick retries discovery; individual jobs record processing failures.
    } finally {
      active = false;
    }
  };
  const timer = setInterval(() => void tick(), PROCESSOR_POLL_MS);
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
