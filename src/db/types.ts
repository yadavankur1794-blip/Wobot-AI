import type { QueryResult, QueryResultRow } from "pg";

export interface DatabaseClient {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  release(): void;
}

export interface DatabasePool {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  connect(): Promise<DatabaseClient>;
  end(): Promise<void>;
}
