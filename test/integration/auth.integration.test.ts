import { resolve } from "node:path";

import type { FastifyInstance } from "fastify";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { createAuthRepository } from "../../src/auth/repository.js";
import { createPasswordService } from "../../src/auth/passwords.js";
import { hashSessionToken } from "../../src/auth/sessions.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createPool } from "../../src/db/pool.js";
import type { DatabasePool } from "../../src/db/types.js";

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("INTEGRATION_DATABASE_URL is required for real PostgreSQL integration tests");
}

let pool: DatabasePool;
let app: FastifyInstance;

beforeAll(async () => {
  const config = loadConfig({ ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: "test", LOG_LEVEL: "silent" });
  pool = createPool(config);
  await runMigrations(pool, resolve("migrations"));
  app = buildApp({ database: pool, logLevel: "silent", uploadRoot: "/tmp/test-uploads", reportRoot: "/tmp/test-reports" });
  await app.ready();
});

beforeEach(async () => {
  await pool.query("TRUNCATE sessions, users, merchants CASCADE");
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("authentication with real PostgreSQL", () => {
  it("registers, logs in, rejects bad credentials, and revokes a session", async () => {
    const registration = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { merchantName: "Merchant A", email: "OWNER@example.com", password: "correct horse battery staple" }
    });
    expect(registration.statusCode).toBe(201);
    expect(registration.json().user.role).toBe("MERCHANT_USER");

    const token = registration.json().token as string;
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "owner@example.com", password: "correct horse battery staple" }
    });
    expect(login.statusCode).toBe(200);

    const invalid = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "owner@example.com", password: "wrong password" }
    });
    expect(invalid.statusCode).toBe(401);

    const me = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe("owner@example.com");

    const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${token}` } });
    expect(logout.statusCode).toBe(204);
    const afterLogout = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("enforces normalized-email uniqueness under concurrent registration", async () => {
    const payload = { merchantName: "Merchant A", email: "OWNER@example.com", password: "correct horse battery staple" };
    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/auth/register", payload }),
      app.inject({ method: "POST", url: "/auth/register", payload: { ...payload, merchantName: "Merchant B" } })
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const count = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM users");
    expect(count.rows[0]?.count).toBe("1");
  });

  it("does not accept client role/merchant fields and expires sessions server-side", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        merchantName: "Merchant A",
        email: "owner@example.com",
        password: "correct horse battery staple",
        role: "PLATFORM_STAFF",
        merchantId: "another-merchant"
      }
    });
    expect(response.statusCode).toBe(400);

    const registration = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { merchantName: "Merchant A", email: "owner@example.com", password: "correct horse battery staple" }
    });
    const token = registration.json().token as string;
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE token_hash = $1", [hashSessionToken(token)]);
    const expired = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(expired.statusCode).toBe(401);
  });

  it("keeps staff identity separate from merchant membership", async () => {
    const repository = createAuthRepository(pool);
    const passwordService = createPasswordService();
    await repository.createStaff({
      email: "staff@example.com",
      passwordHash: await passwordService.hash("staff password that is long")
    });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "staff@example.com", password: "staff password that is long" }
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user).toMatchObject({ role: "PLATFORM_STAFF", merchantId: null });
  });
});
