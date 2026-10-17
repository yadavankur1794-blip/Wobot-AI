import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { WriteStream } from "node:fs";

function csv(value: string): string {
  // Prefix spreadsheet formula-triggering values while keeping the report a
  // useful text/CSV artifact. This prevents a downloaded report from
  // executing attacker-controlled cells when opened in common spreadsheets.
  const safeValue = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safeValue) ? `"${safeValue.replaceAll('"', '""')}"` : safeValue;
}

async function write(stream: WriteStream, value: string): Promise<void> {
  if (!stream.write(value)) await once(stream, "drain");
}

export interface RejectionReport {
  key: string;
  finish(): Promise<void>;
  reject(input: {
    ordinal: number;
    lineStart: number;
    lineEnd: number;
    field: string;
    reason: string;
    code: string;
    fields: readonly string[];
    rawRecord: string;
  }): Promise<void>;
  abort(): Promise<void>;
}

export async function createRejectionReport(root: string): Promise<RejectionReport> {
  await mkdir(root, { recursive: true });
  const id = randomUUID();
  const key = `${id}.csv`;
  const temporary = join(root, `${id}.part`);
  const finalPath = join(root, key);
  const stream = createWriteStream(temporary, { flags: "wx" });
  await write(stream, "record_ordinal,line_start,line_end,field,reason,original_fields,error_code,raw_record\n");
  return {
    key,
    async reject(input) {
      await write(stream, [
        input.ordinal,
        input.lineStart,
        input.lineEnd,
        input.field,
        input.reason,
        JSON.stringify(input.fields),
        input.code,
        input.rawRecord
      ].map((value) => csv(String(value))).join(",") + "\n");
    },
    async finish() {
      stream.end();
      await once(stream, "finish");
      await rename(temporary, finalPath);
    },
    async abort() {
      stream.destroy();
      await rm(temporary, { force: true });
    }
  };
}

export async function discardReport(root: string, key: string): Promise<void> {
  await rm(join(root, key), { force: true });
  await rm(join(root, key.replace(/\.csv$/, ".part")), { force: true });
}
