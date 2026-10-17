import pg from "pg";

import type { AppConfig } from "../config.js";
import type { DatabasePool } from "./types.js";

const { Pool } = pg;

export function createPool(config: AppConfig): DatabasePool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    application_name: "bulk-csv-ingestion-service"
  });
}
