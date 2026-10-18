import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { EncodingTransform } from "../src/imports/decoder.js";

async function decode(chunks: Buffer[], encoding: "utf8" | "utf16le" | "windows-1252"): Promise<string> {
  const decoder = new EncodingTransform(encoding);
  Readable.from(chunks).pipe(decoder);
  const output: Buffer[] = [];
  for await (const chunk of decoder) output.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(output).toString("utf8");
}

describe("streaming input decoder", () => {
  it("handles a UTF-8 BOM and chunk boundaries", async () => {
    const bytes = Buffer.from("\uFEFFsku,name\nA,Éclair\n", "utf8");
    expect(await decode([bytes.subarray(0, 1), bytes.subarray(1, 4), bytes.subarray(4)], "utf8")).toContain("Éclair");
  });

  it("handles UTF-16LE with a BOM", async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("sku,name\nA,灯", "utf16le")]);
    expect(await decode([bytes.subarray(0, 2), bytes.subarray(2, 7), bytes.subarray(7)], "utf16le")).toContain("灯");
  });

  it("rejects UTF-16LE without its required BOM", async () => {
    await expect(decode([Buffer.from("sku,name\n", "utf16le")], "utf16le")).rejects.toThrow("BOM");
  });
});
