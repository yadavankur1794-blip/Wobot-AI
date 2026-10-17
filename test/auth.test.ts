import { createHash } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { createPasswordService } from "../src/auth/passwords.js";
import { registerAuthRoutes } from "../src/auth/routes.js";
import { createSessionService, hashSessionToken } from "../src/auth/sessions.js";

interface FakeUser {
  id: string;
  merchantId: string | null;
  email: string;
  passwordHash: string;
  role: "MERCHANT_USER" | "PLATFORM_STAFF";
}

interface FakeSession {
  id: string;
  userId: string;
  merchantId: string | null;
  email: string;
  role: "MERCHANT_USER" | "PLATFORM_STAFF";
}

function makeError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function makeFakeRepository() {
  const users = new Map<string, FakeUser>();
  const sessions = new Map<string, FakeSession>();
  let sequence = 0;
  let sessionsEnabled = true;

  const repository = {
    async createMerchantUser(input: { merchantName: string; email: string; passwordHash: string }) {
      void input.merchantName;
      if (users.has(input.email)) {
        throw makeError("23505");
      }
      const user: FakeUser = {
        id: `user-${++sequence}`,
        merchantId: `merchant-${sequence}`,
        email: input.email,
        passwordHash: input.passwordHash,
        role: "MERCHANT_USER"
      };
      users.set(user.email, user);
      return user;
    },
    async findUserByEmail(email: string) {
      return users.get(email) ?? null;
    },
    async createSession(input: { userId: string; tokenHash: Buffer; expiresAt: Date }) {
      void input.expiresAt;
      const user = [...users.values()].find((candidate) => candidate.id === input.userId);
      if (!user) {
        throw new Error("unknown user");
      }
      const id = `session-${++sequence}`;
      sessions.set(input.tokenHash.toString("hex"), {
        id,
        userId: user.id,
        merchantId: user.merchantId,
        email: user.email,
        role: user.role
      });
      return id;
    },
    async findSessionByTokenHash(tokenHash: Buffer) {
      if (!sessionsEnabled) {
        return null;
      }
      return sessions.get(tokenHash.toString("hex")) ?? null;
    },
    async revokeSession(sessionId: string) {
      for (const [key, session] of sessions) {
        if (session.id === sessionId) {
          sessions.delete(key);
        }
      }
    },
    async createStaff(input: { email: string; passwordHash: string }) {
      if (users.has(input.email)) {
        throw makeError("23505");
      }
      const user: FakeUser = {
        id: `user-${++sequence}`,
        merchantId: null,
        email: input.email,
        passwordHash: input.passwordHash,
        role: "PLATFORM_STAFF"
      };
      users.set(user.email, user);
      return user;
    },
    expireSessions() {
      sessionsEnabled = false;
    }
  };

  return repository;
}

async function makeAuthApp(): Promise<{
  app: FastifyInstance;
  repository: ReturnType<typeof makeFakeRepository>;
}> {
  const repository = makeFakeRepository();
  const passwordService = createPasswordService();
  const sessionService = createSessionService(repository);
  const app = Fastify({ logger: false });
  app.decorateRequest("auth", null);
  registerAuthRoutes(app, { repository, passwordService, sessionService });
  await app.ready();
  return { app, repository };
}

describe("authentication routes", () => {
  it("registers a merchant user and issues an opaque session", async () => {
    const { app } = await makeAuthApp();
    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { merchantName: "Merchant A", email: "Owner@Example.com", password: "correct horse battery staple" }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().user).toMatchObject({ email: "owner@example.com", role: "MERCHANT_USER" });
    expect(response.json().token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.json().token).not.toContain("correct horse");
    await app.close();
  });

  it("rejects duplicate emails and client role/merchant escalation fields", async () => {
    const { app } = await makeAuthApp();
    const payload = { merchantName: "Merchant A", email: "owner@example.com", password: "correct horse battery staple" };
    expect((await app.inject({ method: "POST", url: "/auth/register", payload })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/auth/register", payload })).statusCode).toBe(409);
    expect((await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { ...payload, email: "staff@example.com", role: "PLATFORM_STAFF", merchantId: "other" }
    })).statusCode).toBe(400);
    await app.close();
  });

  it("returns the same generic error for an invalid password or unknown email", async () => {
    const { app } = await makeAuthApp();
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { merchantName: "Merchant A", email: "owner@example.com", password: "correct horse battery staple" }
    });
    const invalidPassword = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "owner@example.com", password: "wrong password" }
    });
    const unknownEmail = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "unknown@example.com", password: "wrong password" }
    });
    expect(invalidPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(invalidPassword.json()).toEqual(unknownEmail.json());
    await app.close();
  });

  it("requires authentication and revokes a session on logout", async () => {
    const { app } = await makeAuthApp();
    const unauthenticated = await app.inject({ method: "GET", url: "/auth/me" });
    expect(unauthenticated.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { merchantName: "Merchant A", email: "owner@example.com", password: "correct horse battery staple" }
    });
    const token = login.json().token as string;
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.role).toBe("MERCHANT_USER");
    const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${token}` } });
    expect(logout.statusCode).toBe(204);
    const afterLogout = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(afterLogout.statusCode).toBe(401);
    await app.close();
  });

  it("keeps staff role and merchant membership server-controlled", async () => {
    const { app, repository } = await makeAuthApp();
    const passwordService = createPasswordService();
    await repository.createStaff({
      email: "staff@example.com",
      passwordHash: await passwordService.hash("staff password that is long")
    });
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "staff@example.com", password: "staff password that is long" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ role: "PLATFORM_STAFF", merchantId: null });
    await app.close();
  });

  it("uses Argon2id hashes and rejects expired/revoked session lookups", async () => {
    const passwordService = createPasswordService();
    const hash = await passwordService.hash("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await passwordService.verify(hash, "correct horse battery staple")).toBe(true);
    expect(await passwordService.verify(hash, "wrong password")).toBe(false);

    const repository = makeFakeRepository();
    const user = await repository.createMerchantUser({
      merchantName: "Merchant A",
      email: "owner@example.com",
      passwordHash: hash
    });
    const sessions = createSessionService(repository);
    const issued = await sessions.issue(user);
    expect(await sessions.authenticate(issued.token)).not.toBeNull();
    repository.expireSessions();
    expect(await sessions.authenticate(issued.token)).toBeNull();
    expect(hashSessionToken(issued.token).equals(createHash("sha256").update(issued.token).digest())).toBe(true);
  });
});
