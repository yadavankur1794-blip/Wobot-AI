import { describe, expect, it } from "vitest";
import { parse } from "csv-parse/sync";

import { REQUIRED_COLUMNS, validateHeader, validateProduct } from "../src/imports/validation.js";
import { ISO_4217_MINOR_UNITS } from "../src/imports/currencies.js";

const valid = ["A-1", "Desk, Lamp\n(refurbished)", "lighting", "100", "JPY", "0", "2025-03-01T10:00:00+05:30"];

describe("CSV product validation", () => {
  it("maps shuffled headers without changing field identity", () => {
    const header = ["name", "updated_at", "sku", "category", "currency", "price", "stock"];
    const mapping = validateHeader(header);
    expect("indexes" in mapping).toBe(true);
    if (!("indexes" in mapping)) throw new Error("test header invalid");
    const result = validateProduct([valid[1]!, valid[6]!, valid[0]!, valid[2]!, valid[4]!, valid[3]!, valid[5]!], mapping.indexes);
    expect(result).toMatchObject({ sku: "A-1", price: "100", currency: "JPY", stock: "0" });
  });

  it("rejects missing and duplicate mandatory headers while ignoring extras", () => {
    expect(validateHeader(REQUIRED_COLUMNS.slice(0, -1))).toMatchObject({ field: "header" });
    expect(validateHeader([...REQUIRED_COLUMNS, "sku"])).toMatchObject({ field: "header", reason: expect.stringContaining("Duplicate") });
    expect(validateHeader([...REQUIRED_COLUMNS, "extra"])).toHaveProperty("indexes");
  });

  it.each([
    ["price", ["A", "N", "C", "1.001", "USD", "1", "2025-01-01T00:00:00Z"]],
    ["currency", ["A", "N", "C", "1", "DOLLARS", "1", "2025-01-01T00:00:00Z"]],
    ["stock", ["A", "N", "C", "1", "USD", "1.5", "2025-01-01T00:00:00Z"]],
    ["updated_at", ["A", "N", "C", "1", "USD", "1", "2025-13-45T00:00:00Z"]]
  ])("rejects invalid %s", (field, row) => {
    const mapping = validateHeader(REQUIRED_COLUMNS);
    if (! ("indexes" in mapping)) throw new Error("test header invalid");
    expect(validateProduct(row, mapping.indexes)).toMatchObject({ field });
  });

  it("preserves exact decimal text and accepts zero stock", () => {
    const mapping = validateHeader(REQUIRED_COLUMNS);
    if (! ("indexes" in mapping)) throw new Error("test header invalid");
    expect(validateProduct(["A", "N", "C", "24.99", "USD", "0", "2025-01-01T00:00:00Z"], mapping.indexes)).toMatchObject({ price: "24.99", stock: "0" });
  });

  it.each([
    ["JPY", "100"],
    ["USD", "100.00"],
    ["BHD", "100.123"],
    ["KWD", "100.123"],
    ["CLF", "100.1234"]
  ])("accepts ISO-4217 currency %s with its exact minor-unit scale", (currency, price) => {
    const mapping = validateHeader(REQUIRED_COLUMNS);
    if (!("indexes" in mapping)) throw new Error("test header invalid");
    expect(validateProduct(["A", "N", "C", price, currency, "0", "2025-01-01T00:00:00Z"], mapping.indexes)).toMatchObject({ currency, price });
  });

  it("uses ISO minor units rather than locale display defaults", () => {
    expect(ISO_4217_MINOR_UNITS).toMatchObject({ AFN: 2, COP: 2, HUF: 2, IQD: 3, JPY: 0, UYW: 4 });
  });

  it("does not map prototype-looking headers into an object", () => {
    const prototype = Object.prototype as Record<string, unknown>;
    const before = prototype.polluted;
    const parsed = parse("__proto__,constructor,prototype\nfirst,second,third\n", {
      columns: false,
      group_columns_by_name: false
    });
    expect(parsed).toEqual([["__proto__", "constructor", "prototype"], ["first", "second", "third"]]);
    expect(prototype.polluted).toBe(before);
  });

  it.each([
    ["JPY", "100.0"],
    ["BHD", "100.1234"],
    ["CLF", "100.12345"]
  ])("rejects prices exceeding the ISO-4217 minor-unit scale for %s", (currency, price) => {
    const mapping = validateHeader(REQUIRED_COLUMNS);
    if (!("indexes" in mapping)) throw new Error("test header invalid");
    expect(validateProduct(["A", "N", "C", price, currency, "0", "2025-01-01T00:00:00Z"], mapping.indexes)).toMatchObject({ field: "price" });
  });
});
