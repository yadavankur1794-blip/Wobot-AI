import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { MAX_FILE_BYTES } from "../src/imports/constants.js";
import { createUploadStorage } from "../src/imports/storage.js";

describe("upload storage", () => {
  it("streams bytes to a generated key and computes SHA-256", async () => {
    const root = await mkdtemp(join(tmpdir(), "csv-upload-"));
    try {
      const storage = createUploadStorage(root);
      const stored = await storage.store(Readable.from([Buffer.from("sku,name\nA,Alpha\n")]) as never, "input.csv");

      expect(stored.storageKey).toMatch(/^[0-9a-f-]{36}\.csv$/);
      expect(stored.byteSize).toBe(17);
      expect(stored.contentHash.toString("hex")).toBe(
        "070ad35b9a92c57b25a88bdd350f96b062d3d4456200f58b64e2fa30e91bcc3c"
      );
      expect(await readFile(join(root, stored.storageKey), "utf8")).toBe("sku,name\nA,Alpha\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes temporary files when the filename limit is exceeded", async () => {
    const root = await mkdtemp(join(tmpdir(), "csv-upload-"));
    try {
      const storage = createUploadStorage(root);
      await expect(storage.store(Readable.from(["data"]) as never, "x".repeat(1025))).rejects.toMatchObject({
        kind: "LIMIT"
      });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes stale unreferenced files and all interrupted parts", async () => {
    const root = await mkdtemp(join(tmpdir(), "csv-upload-"));
    try {
      const storage = createUploadStorage(root);
      const stale = join(root, "00000000-0000-0000-0000-000000000000.csv");
      const active = join(root, "11111111-1111-1111-1111-111111111111.csv");
      await writeFile(stale, "stale");
      await writeFile(active, "active");
      await writeFile(join(root, "interrupted.part"), "partial");
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(stale, old, old);

      await storage.reconcileOrphans(new Set(["11111111-1111-1111-1111-111111111111.csv"]));

      expect(await readdir(root)).toEqual(["11111111-1111-1111-1111-111111111111.csv"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an oversized stream before committing a final file", async () => {
    const root = await mkdtemp(join(tmpdir(), "csv-upload-"));
    try {
      const storage = createUploadStorage(root);
      const oversized = Readable.from((async function* () {
        yield Buffer.alloc(1);
        yield Buffer.alloc(MAX_FILE_BYTES);
      })());
      await expect(storage.store(oversized as never, "input.csv")).rejects.toMatchObject({ kind: "LIMIT" });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans up after a simulated ENOSPC storage failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "csv-upload-"));
    try {
      const storage = createUploadStorage(root);
      const failed = Readable.from((async function* () {
        yield Buffer.from("partial");
        const error = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
        throw error;
      })());
      await expect(storage.store(failed as never, "input.csv")).rejects.toMatchObject({ kind: "STORAGE" });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
