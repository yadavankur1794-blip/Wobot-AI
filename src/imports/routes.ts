import { createReadStream } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { createRequireAuth } from "../auth/guards.js";
import type { SessionService } from "../auth/sessions.js";
import type { AuthenticatedRequest } from "../auth/types.js";
import {
  MAX_FIELD_BYTES,
  MAX_FILES_PER_REQUEST,
  MAX_FILENAME_BYTES,
  MAX_FILE_BYTES,
  MAX_MULTIPART_FIELDS,
  MAX_MULTIPART_PARTS,
  MAX_REQUEST_BYTES,
  MAX_SIMULTANEOUS_UPLOADS
} from "./constants.js";
import type { ImportRepository } from "./repository.js";
import { UploadStorageError, type UploadStorage } from "./storage.js";

const importQuerySchema = z.object({
  merchantId: z.uuid().optional(),
  encoding: z.enum(["utf8", "utf16le", "windows-1252"]).default("utf8")
}).strict();
const importParamsSchema = z.object({ importId: z.uuid() }).strict();
let activeUploads = 0;

export interface ImportRouteDependencies {
  repository: ImportRepository;
  storage: UploadStorage;
  sessionService: SessionService;
  reportRoot: string;
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function isMultipartLimitError(error: unknown): boolean {
  if (error instanceof UploadStorageError) {
    return error.kind === "LIMIT";
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; statusCode?: unknown };
  return candidate.statusCode === 413 || (typeof candidate.code === "string" && candidate.code.startsWith("FST_") && candidate.code.endsWith("_LIMIT")) || candidate.code === "FST_REQ_FILE_TOO_LARGE";
}

function targetMerchant(request: AuthenticatedRequest): string | null {
  const parsed = importQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return null;
  }
  if (request.auth.role === "PLATFORM_STAFF") {
    return parsed.data.merchantId ?? null;
  }
  if (parsed.data.merchantId && parsed.data.merchantId !== request.auth.merchantId) {
    return null;
  }
  return request.auth.merchantId;
}

function resultForImport(importResult: { duplicate: boolean; import: { id: string; status: string; originalFilename: string; fileSizeBytes: string } }) {
  return {
    id: importResult.import.id,
    originalFilename: importResult.import.originalFilename,
    fileSizeBytes: importResult.import.fileSizeBytes,
    status: importResult.import.status,
    duplicate: importResult.duplicate
  };
}

function importStatus(importRecord: {
  id: string;
  originalFilename: string;
  status: string;
  cancelRequested: boolean;
  scannedRows: string;
  validRows: string;
  rejectedRows: string;
  distinctProducts: string;
  publishedRows: string;
  createdAt: Date;
  updatedAt: Date;
  errorCode: string | null;
  errorMessage: string | null;
}) {
  return {
    id: importRecord.id,
    originalFilename: importRecord.originalFilename,
    status: importRecord.status,
    cancelRequested: importRecord.cancelRequested,
    counters: {
      scannedRows: importRecord.scannedRows,
      validRows: importRecord.validRows,
      rejectedRows: importRecord.rejectedRows,
      distinctProducts: importRecord.distinctProducts,
      publishedRows: importRecord.publishedRows
    },
    createdAt: importRecord.createdAt.toISOString(),
    updatedAt: importRecord.updatedAt.toISOString(),
    error: importRecord.errorCode ? { code: importRecord.errorCode, message: importRecord.errorMessage } : null
  };
}

export function registerImportRoutes(app: FastifyInstance, dependencies: ImportRouteDependencies): void {
  const requireAuth = createRequireAuth(dependencies.sessionService);

  app.post("/imports", { onRequest: requireAuth, bodyLimit: MAX_REQUEST_BYTES }, async (request, reply) => {
    const actor = request as AuthenticatedRequest;
    if (activeUploads >= MAX_SIMULTANEOUS_UPLOADS) {
      return reply.code(429).send(errorBody("UPLOAD_CAPACITY", "Too many uploads are active"));
    }
    const merchantId = targetMerchant(actor);
    if (!merchantId) {
      return reply.code(403).send(errorBody("MERCHANT_ACCESS_DENIED", "A valid target merchant is required"));
    }
    const query = importQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(errorBody("INVALID_REQUEST", "Upload query parameters are invalid"));
    }
    if (!request.isMultipart()) {
      return reply.code(415).send(errorBody("MULTIPART_REQUIRED", "Content-Type must be multipart/form-data"));
    }

    activeUploads += 1;
    const results: Array<ReturnType<typeof resultForImport>> = [];
    let fileCount = 0;
    try {
      const parts = request.parts({
        limits: {
          fileSize: MAX_FILE_BYTES,
          files: MAX_FILES_PER_REQUEST,
          fields: MAX_MULTIPART_FIELDS,
          fieldSize: MAX_FIELD_BYTES,
          parts: MAX_MULTIPART_PARTS,
          fieldNameSize: 256,
          headerPairs: 200
        }
      });
      for await (const part of parts) {
        if (part.type === "field") {
          continue;
        }
        fileCount += 1;
        if (Buffer.byteLength(part.filename, "utf8") > MAX_FILENAME_BYTES) {
          part.file.resume();
          throw new UploadStorageError("Filename is too long", "LIMIT");
        }
        const stored = await dependencies.storage.store(part.file, part.filename);
        const registered = await dependencies.repository.createImport({
          merchantId,
          originalFilename: part.filename,
          storageKey: stored.storageKey,
          contentHash: stored.contentHash,
          fileSizeBytes: stored.byteSize,
          inputEncoding: query.data.encoding
        });
        if (registered.duplicate) {
          await dependencies.storage.remove(stored.storageKey);
        }
        results.push(resultForImport(registered));
      }
    } catch (error: unknown) {
      request.log.error({ err: error, merchantId, fileCount }, "multipart upload failed");
      const statusCode = isMultipartLimitError(error) ? 413 : 500;
      return reply.code(statusCode).send(errorBody(
        statusCode === 413 ? "UPLOAD_LIMIT_EXCEEDED" : "UPLOAD_FAILED",
        statusCode === 413 ? "The upload exceeds the configured limit" : "The upload could not be stored"
      ));
    } finally {
      activeUploads -= 1;
    }

    if (fileCount === 0) {
      return reply.code(400).send(errorBody("FILE_REQUIRED", "At least one CSV file is required"));
    }
    return reply.code(202).send({ imports: results });
  });

  app.get("/imports/:importId", { onRequest: requireAuth }, async (request: FastifyRequest, reply) => {
    const parsed = importParamsSchema.safeParse(request.params);
    const actor = request.auth;
    if (!parsed.success || !actor) {
      return reply.code(404).send(errorBody("IMPORT_NOT_FOUND", "Import not found"));
    }
    const found = await dependencies.repository.findVisibleImport(parsed.data.importId, actor);
    if (!found) {
      return reply.code(404).send(errorBody("IMPORT_NOT_FOUND", "Import not found"));
    }
    return reply.code(200).send({ import: importStatus(found) });
  });

  app.get("/imports/:importId/rejections", { onRequest: requireAuth }, async (request: FastifyRequest, reply) => {
    const parsed = importParamsSchema.safeParse(request.params);
    const actor = request.auth;
    if (!parsed.success || !actor) {
      return reply.code(404).send(errorBody("IMPORT_NOT_FOUND", "Import not found"));
    }
    const found = await dependencies.repository.findVisibleImport(parsed.data.importId, actor);
    if (!found) {
      return reply.code(404).send(errorBody("IMPORT_NOT_FOUND", "Import not found"));
    }
    if (!found.reportKey) {
      return reply.code(409).send(errorBody("REPORT_NOT_READY", "The rejection report is not ready"));
    }
    if (!/^[0-9a-f-]{36}\.csv$/.test(found.reportKey)) {
      request.log.error({ importId: found.id }, "stored report key is invalid");
      return reply.code(500).send(errorBody("REPORT_UNAVAILABLE", "The rejection report is unavailable"));
    }
    return reply.type("text/csv; charset=utf-8").send(createReadStream(join(dependencies.reportRoot, found.reportKey)));
  });

  app.post("/imports/:importId/cancel", { onRequest: requireAuth }, async (request: FastifyRequest, reply) => {
    const parsed = importParamsSchema.safeParse(request.params);
    const actor = request.auth;
    if (!parsed.success || !actor) return reply.code(404).send(errorBody("IMPORT_NOT_FOUND", "Import not found"));
    const outcome = await dependencies.repository.cancelImport(parsed.data.importId, actor);
    if (outcome === "NOT_FOUND") return reply.code(404).send(errorBody("IMPORT_NOT_FOUND", "Import not found"));
    if (outcome === "IN_PROGRESS") return reply.code(409).send(errorBody("PUBLICATION_IN_PROGRESS", "The import is already being published"));
    if (outcome === "TERMINAL") return reply.code(409).send(errorBody("IMPORT_TERMINAL", "The import cannot be cancelled in its current state"));
    const status = outcome === "REQUESTED" ? 202 : 200;
    return reply.code(status).send({ importId: parsed.data.importId, status: outcome === "REQUESTED" ? "CANCEL_REQUESTED" : "CANCELLED" });
  });
}
