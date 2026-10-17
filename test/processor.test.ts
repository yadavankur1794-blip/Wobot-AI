import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ImportSummary, ImportRepository } from "../src/imports/repository.js";
import { processNextImport } from "../src/imports/processor.js";

const csvHeader = "sku,name,category,price,currency,stock,updated_at";

function importSummary(storageKey: string): ImportSummary {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    merchantId: "00000000-0000-4000-8000-000000000002",
    originalFilename: "processor.csv",
    storageKey,
    contentHash: Buffer.alloc(32),
    fileSizeBytes: "0",
    inputEncoding: "utf8",
    reportKey: null,
    status: "QUEUED",
    cancelRequested: false,
    scannedRows: "0",
    validRows: "0",
    rejectedRows: "0",
    distinctProducts: "0",
    publishedRows: "0",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    attempt: "1",
    leaseOwner: null
  };
}

describe("import processor progress counts", () => {
  it("counts staged products once at finalization instead of once per 500-row update", async () => {
    const root = await mkdtemp(join(tmpdir(), "csv-processor-"));
    try {
      const storageKey = "processor.csv";
      const rows = [csvHeader];
      for (let index = 0; index < 1001; index += 1) {
        rows.push(`SKU-${index},Product ${index},books,10.00,USD,1,2026-01-01T00:00:00Z`);
      }
      await writeFile(join(root, storageKey), `${rows.join("\n")}\n`, "utf8");

      const job = importSummary(storageKey);
      const updates: Array<{ scannedRows: number; distinctProducts: number }> = [];
      const stagedBatchSizes: number[] = [];
      const countStaged = vi.fn(async () => 1001);
      let claimed = true;
      const repository = {
        claimNextReady: vi.fn(async () => null),
        claimNextQueued: vi.fn(async () => {
          if (!claimed) return null;
          claimed = false;
          return job;
        }),
        reclaimExpired: vi.fn(async () => 0),
        checkLease: vi.fn(async () => "ACTIVE" as const),
        stageBatch: vi.fn(async (_importId: string, rowsToStage: readonly unknown[]) => {
          stagedBatchSizes.push(rowsToStage.length);
        }),
        updateProgress: vi.fn(async (_importId: string, counters: { scannedRows: number; distinctProducts: number }) => {
          updates.push({ scannedRows: counters.scannedRows, distinctProducts: counters.distinctProducts });
        }),
        markReady: vi.fn(async () => undefined),
        markFailed: vi.fn(async () => undefined),
        countStaged,
        completeCancellation: vi.fn(async () => false),
        cancelImport: vi.fn(async () => "NOT_FOUND" as const),
        createImport: vi.fn(),
        findVisibleImport: vi.fn(),
        listStorageKeys: vi.fn(),
        listReportKeys: vi.fn()
      } as unknown as ImportRepository;

      await expect(processNextImport({
        repository,
        uploadRoot: root,
        reportRoot: join(root, "reports"),
        ownerId: "processor-test-owner"
      })).resolves.toBe(true);

      expect(stagedBatchSizes).toEqual([500, 500, 1]);
      expect(countStaged).toHaveBeenCalledTimes(1);
      expect(countStaged).toHaveBeenCalledWith(job.id);
      expect(updates.at(-1)).toEqual({ scannedRows: 1001, distinctProducts: 1001 });
      expect(updates.slice(0, -1).every((update) => update.distinctProducts === 0)).toBe(true);
      expect(repository.markReady).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
