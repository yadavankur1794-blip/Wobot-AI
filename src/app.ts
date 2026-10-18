import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";

import type { LogLevel } from "./config.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { createAuthRepository } from "./auth/repository.js";
import { createPasswordService } from "./auth/passwords.js";
import { createSessionService } from "./auth/sessions.js";
import type { DatabasePool } from "./db/types.js";
import { MAX_FILE_BYTES, MAX_MULTIPART_FIELDS, MAX_MULTIPART_PARTS, MAX_REQUEST_BYTES } from "./imports/constants.js";
import { createImportRepository } from "./imports/repository.js";
import { registerImportRoutes } from "./imports/routes.js";
import { createUploadStorage } from "./imports/storage.js";

export interface HealthDatabase {
  query(sql: string): Promise<unknown>;
}

export interface AppDependencies {
  database: DatabasePool;
  logLevel: LogLevel;
  uploadRoot: string;
  reportRoot: string;
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({
    bodyLimit: MAX_REQUEST_BYTES,
    logger: {
      level: dependencies.logLevel
    }
  });

  app.register(multipart, {
    limits: {
      fileSize: MAX_FILE_BYTES,
      files: 8,
      fields: MAX_MULTIPART_FIELDS,
      parts: MAX_MULTIPART_PARTS,
      fieldSize: 16 * 1024,
      fieldNameSize: 256,
      headerPairs: 200
    },
    throwFileSizeLimit: true
  });

  app.decorateRequest("auth", null);

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      await dependencies.database.query("SELECT 1");
      return { status: "ok", database: "ok" };
    } catch (error: unknown) {
      app.log.error({ err: error }, "readiness check failed");
      return reply.code(503).send({ status: "not_ready", database: "unavailable" });
    }
  });

  const authRepository = createAuthRepository(dependencies.database);
  const sessionService = createSessionService(authRepository);
  registerAuthRoutes(app, {
    repository: authRepository,
    passwordService: createPasswordService(),
    sessionService
  });

  registerImportRoutes(app, {
    repository: createImportRepository(dependencies.database),
    storage: createUploadStorage(dependencies.uploadRoot),
    sessionService,
    reportRoot: dependencies.reportRoot
  });

  return app;
}
