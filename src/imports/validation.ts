import { currencyMinorUnits } from "./currencies.js";

export const REQUIRED_COLUMNS = ["sku", "name", "category", "price", "currency", "stock", "updated_at"] as const;
export type RequiredColumn = (typeof REQUIRED_COLUMNS)[number];

export type ValidationErrorCode =
  | "INVALID_HEADER"
  | "INVALID_SKU"
  | "UNSUPPORTED_CURRENCY"
  | "INVALID_PRICE"
  | "INVALID_STOCK"
  | "INVALID_TIMESTAMP";

export interface ValidProduct {
  sku: string;
  name: string;
  category: string;
  price: string;
  currency: string;
  stock: string;
  updatedAt: Date;
}

export interface ValidationFailure {
  code: ValidationErrorCode;
  field: string;
  reason: string;
}

export function normalizeHeader(value: string): string {
  return value.trim().toLowerCase();
}

export function validateHeader(header: readonly string[]): { indexes: Record<RequiredColumn, number> } | ValidationFailure {
  const normalized = header.map(normalizeHeader);
  const indexes = {} as Record<RequiredColumn, number>;
  for (const column of REQUIRED_COLUMNS) {
    const matches = normalized.flatMap((value, index) => value === column ? [index] : []);
    if (matches.length === 0) {
      return { code: "INVALID_HEADER", field: "header", reason: `Missing required column: ${column}` };
    }
    if (matches.length > 1) {
      return { code: "INVALID_HEADER", field: "header", reason: `Duplicate required column: ${column}` };
    }
    indexes[column] = matches[0]!;
  }
  return { indexes };
}

function validateMoney(value: string, currency: string): string | null {
  const scale = currencyMinorUnits(currency);
  if (scale === undefined) {
    return "Currency is not a supported ISO-4217 code";
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    return "Price must be a non-negative decimal without exponent notation";
  }
  const parts = value.split(".");
  const whole = parts[0] ?? "";
  const fraction = parts[1] ?? "";
  if (fraction.length > scale) {
    return `Price has more than ${scale} fractional digits for ${currency}`;
  }
  if (whole.length + fraction.length > 20) {
    return "Price exceeds the supported NUMERIC precision";
  }
  return null;
}

function validateTimestamp(value: string): Date | string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return "Timestamp must be ISO-8601 with an explicit timezone";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Timestamp is not a real instant" : date;
}

export function validateProduct(row: readonly string[], indexes: Record<RequiredColumn, number>): ValidProduct | ValidationFailure {
  const value = (column: RequiredColumn): string => row[indexes[column]] ?? "";
  const sku = value("sku");
  if (sku.length === 0) return { code: "INVALID_SKU", field: "sku", reason: "SKU is required" };

  const currency = value("currency");
  if (currencyMinorUnits(currency) === undefined) {
    return { code: "UNSUPPORTED_CURRENCY", field: "currency", reason: "Currency is not a supported ISO-4217 code" };
  }
  const priceError = validateMoney(value("price"), currency);
  if (priceError) return { code: "INVALID_PRICE", field: "price", reason: priceError };

  const stock = value("stock");
  if (!/^\d+$/.test(stock)) return { code: "INVALID_STOCK", field: "stock", reason: "Stock must be a non-negative whole number" };
  try {
    const stockValue = BigInt(stock);
    if (stockValue > 9_223_372_036_854_775_807n) return { code: "INVALID_STOCK", field: "stock", reason: "Stock exceeds PostgreSQL BIGINT range" };
  } catch {
    return { code: "INVALID_STOCK", field: "stock", reason: "Stock is invalid" };
  }

  const updatedAt = validateTimestamp(value("updated_at"));
  if (typeof updatedAt === "string") return { code: "INVALID_TIMESTAMP", field: "updated_at", reason: updatedAt };
  return { sku, name: value("name"), category: value("category"), price: value("price"), currency, stock, updatedAt };
}
