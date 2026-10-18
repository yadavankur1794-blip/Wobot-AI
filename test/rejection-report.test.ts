import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";

import { createRejectionReport } from "../src/imports/rejection-report.js";

describe("streamed rejection reports", () => {
  it("preserves stable codes, logical locations, parsed fields and decoded raw records", async () => {
    const root = await mkdtemp(join(tmpdir(), "csv-report-"));
    try {
      const report = await createRejectionReport(root);
      await report.reject({
        ordinal: 3,
        lineStart: 4,
        lineEnd: 5,
        field: "price",
        reason: "Price is invalid",
        code: "INVALID_PRICE",
        fields: ["SKU-3", "Desk, Lamp\n(refurbished)", "N/A"],
        rawRecord: "SKU-3,\"Desk, Lamp\n(refurbished)\",N/A\r\n"
      });
      await report.finish();

      const rows = parse(await readFile(join(root, report.key), "utf8"), { columns: true });
      expect(rows).toEqual([{
        record_ordinal: "3",
        line_start: "4",
        line_end: "5",
        field: "price",
        reason: "Price is invalid",
        original_fields: JSON.stringify(["SKU-3", "Desk, Lamp\n(refurbished)", "N/A"]),
        error_code: "INVALID_PRICE",
        raw_record: "SKU-3,\"Desk, Lamp\n(refurbished)\",N/A\r\n"
      }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefixes formula-triggering cells for spreadsheet safety", async () => {
    const root = await mkdtemp(join(tmpdir(), "csv-report-safe-"));
    try {
      const report = await createRejectionReport(root);
      await report.reject({
        ordinal: 1,
        lineStart: 2,
        lineEnd: 2,
        field: "sku",
        reason: "Invalid SKU",
        code: "INVALID_SKU",
        fields: ["=2+2"],
        rawRecord: "=2+2,Name,Category,1.00,USD,0,2025-01-01T00:00:00Z\n"
      });
      await report.finish();

      const rows = parse(await readFile(join(root, report.key), "utf8"), { columns: true });
      expect(rows[0]).toMatchObject({
        original_fields: JSON.stringify(["=2+2"]),
        raw_record: "'=2+2,Name,Category,1.00,USD,0,2025-01-01T00:00:00Z\n"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
