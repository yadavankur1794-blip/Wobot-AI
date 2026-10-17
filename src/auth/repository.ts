import type { QueryResultRow } from "pg";

import type { DatabaseClient, DatabasePool } from "../db/types.js";
import type { UserRole } from "./types.js";

export interface UserRecord {
  id: string;
  merchantId: string | null;
  email: string;
  passwordHash: string;
  role: UserRole;
}

export interface SessionRecord {
  id: string;
  userId: string;
  merchantId: string | null;
  email: string;
  role: UserRole;
}

interface UserRow extends QueryResultRow {
  id: string;
  merchant_id: string | null;
  email_normalized: string;
  password_hash: string;
  role: UserRole;
}

interface SessionRow extends QueryResultRow {
  id: string;
  user_id: string;
  merchant_id: string | null;
  email_normalized: string;
  role: UserRole;
}

export interface AuthRepository {
  createMerchantUser(input: { merchantName: string; email: string; passwordHash: string }): Promise<UserRecord>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  createSession(input: { userId: string; tokenHash: Buffer; expiresAt: Date }): Promise<string>;
  findSessionByTokenHash(tokenHash: Buffer): Promise<SessionRecord | null>;
  revokeSession(sessionId: string): Promise<void>;
  createStaff(input: { email: string; passwordHash: string }): Promise<UserRecord>;
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    email: row.email_normalized,
    passwordHash: row.password_hash,
    role: row.role
  };
}

export function createAuthRepository(pool: DatabasePool): AuthRepository {
  return {
    async createMerchantUser(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const merchantResult = await client.query<{ id: string }>(
          "INSERT INTO merchants (name) VALUES ($1) RETURNING id",
          [input.merchantName]
        );
        const merchantId = merchantResult.rows[0]?.id;
        if (!merchantId) {
          throw new Error("merchant insert returned no identifier");
        }
        const userResult = await client.query<UserRow>(
          `INSERT INTO users (merchant_id, email_normalized, password_hash, role)
           VALUES ($1, $2, $3, 'MERCHANT_USER')
           RETURNING id, merchant_id, email_normalized, password_hash, role`,
          [merchantId, input.email, input.passwordHash]
        );
        const user = userResult.rows[0];
        if (!user) {
          throw new Error("user insert returned no identifier");
        }
        await client.query("COMMIT");
        return mapUser(user);
      } catch (error: unknown) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async findUserByEmail(email) {
      const result = await pool.query<UserRow>(
        `SELECT u.id, u.merchant_id, u.email_normalized, u.password_hash, u.role
         FROM users u
         LEFT JOIN merchants m ON m.id = u.merchant_id
         WHERE u.email_normalized = $1
           AND (u.role = 'PLATFORM_STAFF' OR m.active = true)`,
        [email]
      );
      const row = result.rows[0];
      return row ? mapUser(row) : null;
    },

    async createSession(input) {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3) RETURNING id`,
        [input.userId, input.tokenHash, input.expiresAt]
      );
      const id = result.rows[0]?.id;
      if (!id) {
        throw new Error("session insert returned no identifier");
      }
      return id;
    },

    async findSessionByTokenHash(tokenHash) {
      const result = await pool.query<SessionRow>(
        `SELECT s.id, s.user_id, u.merchant_id, u.email_normalized, u.role
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN merchants m ON m.id = u.merchant_id
         WHERE s.token_hash = $1
           AND s.revoked_at IS NULL
           AND s.expires_at > now()
           AND (u.role = 'PLATFORM_STAFF' OR m.active = true)`,
        [tokenHash]
      );
      const row = result.rows[0];
      return row
        ? {
            id: row.id,
            userId: row.user_id,
            merchantId: row.merchant_id,
            email: row.email_normalized,
            role: row.role
          }
        : null;
    },

    async revokeSession(sessionId) {
      await pool.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [sessionId]);
    },

    async createStaff(input) {
      const result = await pool.query<UserRow>(
        `INSERT INTO users (merchant_id, email_normalized, password_hash, role)
         VALUES (NULL, $1, $2, 'PLATFORM_STAFF')
         RETURNING id, merchant_id, email_normalized, password_hash, role`,
        [input.email, input.passwordHash]
      );
      const user = result.rows[0];
      if (!user) {
        throw new Error("staff insert returned no identifier");
      }
      return mapUser(user);
    }
  };
}

export async function withTransaction<T>(
  pool: DatabasePool,
  operation: (client: DatabaseClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
