import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { BusboyFileStream } from "@fastify/busboy";

import { MAX_FILENAME_BYTES, MAX_FILE_BYTES, ORPHAN_GRACE_MS } from "./constants.js";

export class UploadStorageError extends Error {
  public readonly kind: "LIMIT" | "STORAGE";

  public constructor(message: string, kind: "LIMIT" | "STORAGE") {
    super(message);
    this.name = "UploadStorageError";
    this.kind = kind;
  }
}

class HashingLimitTransform extends Transform {
  public bytes = 0;
  public readonly hash = createHash("sha256");

  public override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.bytes + buffer.byteLength > MAX_FILE_BYTES) {
      callback(new UploadStorageError("Uploaded file exceeds the 2 GiB limit plus the bounded generator completion margin", "LIMIT"));
      return;
    }
    this.bytes += buffer.byteLength;
    this.hash.update(buffer);
    callback(null, buffer);
  }
}

export interface StoredUpload {
  storageKey: string;
  byteSize: number;
  contentHash: Buffer;
}

export interface UploadStorage {
  ensureRoot(): Promise<void>;
  store(stream: BusboyFileStream, originalFilename: string): Promise<StoredUpload>;
  remove(storageKey: string): Promise<void>;
  reconcileOrphans(referencedKeys: ReadonlySet<string>, now?: number): Promise<void>;
}

function safeStorageKey(storageKey: string): boolean {
  return /^[0-9a-f-]{36}\.csv$/.test(storageKey);
}

export function createUploadStorage(root: string): UploadStorage {
  const pathFor = (storageKey: string): string => {
    if (!safeStorageKey(storageKey)) {
      throw new Error("Invalid application storage key");
    }
    return join(root, storageKey);
  };

  return {
    async ensureRoot() {
      await mkdir(root, { recursive: true });
    },

    async store(stream, originalFilename) {
      if (Buffer.byteLength(originalFilename, "utf8") > MAX_FILENAME_BYTES) {
        stream.resume();
        throw new UploadStorageError("Filename is too long", "LIMIT");
      }

      await mkdir(root, { recursive: true });
      const id = randomUUID();
      const storageKey = `${id}.csv`;
      const temporaryPath = join(root, `${id}.part`);
      const finalPath = pathFor(storageKey);
      const hashing = new HashingLimitTransform();

      try {
        await pipeline(stream, hashing, createWriteStream(temporaryPath, { flags: "wx" }));
        if (stream.truncated) {
          throw new UploadStorageError("Uploaded file exceeded the multipart file-size limit", "LIMIT");
        }
        await rename(temporaryPath, finalPath);
        return {
          storageKey,
          byteSize: hashing.bytes,
          contentHash: hashing.hash.digest()
        };
      } catch (error: unknown) {
        await rm(temporaryPath, { force: true });
        await rm(finalPath, { force: true });
        if (error instanceof UploadStorageError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : "Upload storage failed";
        throw new UploadStorageError(message, "STORAGE");
      }
    },

    async remove(storageKey) {
      await rm(pathFor(storageKey), { force: true });
    },

    async reconcileOrphans(referencedKeys, now = Date.now()) {
      await mkdir(root, { recursive: true });
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        const fileName = basename(entry.name);
        const filePath = join(root, fileName);
        if (fileName.endsWith(".part")) {
          await rm(filePath, { force: true });
          continue;
        }
        if (!safeStorageKey(fileName) || referencedKeys.has(fileName)) {
          continue;
        }
        const metadata = await stat(filePath);
        if (now - metadata.mtimeMs >= ORPHAN_GRACE_MS) {
          await rm(filePath, { force: true });
        }
      }
    }
  };
}
