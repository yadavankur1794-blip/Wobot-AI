import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";

import { buildApp, type HealthDatabase } from "../src/app.js";
import type { DatabasePool } from "../src/db/types.js";

function databaseWithQuery(query: HealthDatabase["query"]): DatabasePool {
  return {
    async query<T extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<T>> {
      void values;
      await query(sql);
      return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] as T[] };
    },
    async connect() {
      throw new Error("connect is not used by this health test");
    },
    async end() {
      return undefined;
    }
  };
}

describe("health endpoints", () => {
  it("reports liveness without a database", async () => {
    const database = databaseWithQuery(async () => undefined);
    const app = buildApp({ database, logLevel: "silent", uploadRoot: "/tmp/test-uploads", reportRoot: "/tmp/test-reports" });

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("reports readiness when the database query succeeds", async () => {
    const database = databaseWithQuery(async () => undefined);
    const app = buildApp({ database, logLevel: "silent", uploadRoot: "/tmp/test-uploads", reportRoot: "/tmp/test-reports" });

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", database: "ok" });
    await app.close();
  });

  it("reports not ready when the database query fails", async () => {
    const database = databaseWithQuery(async () => {
      throw new Error("database unavailable");
    });
    const app = buildApp({ database, logLevel: "silent", uploadRoot: "/tmp/test-uploads", reportRoot: "/tmp/test-reports" });

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready", database: "unavailable" });
    await app.close();
  });
});
