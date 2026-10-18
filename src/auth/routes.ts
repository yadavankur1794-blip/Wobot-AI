import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { createRequireAuth } from "./guards.js";
import type { AuthRepository } from "./repository.js";
import { loginSchema, registerSchema } from "./schemas.js";
import type { PasswordService } from "./passwords.js";
import type { SessionService } from "./sessions.js";

export interface AuthRouteDependencies {
  repository: AuthRepository;
  passwordService: PasswordService;
  sessionService: SessionService;
}

const invalidCredentials = { error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } };
const invalidBody = (message: string) => ({ error: { code: "INVALID_REQUEST", message } });

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export function registerAuthRoutes(app: FastifyInstance, dependencies: AuthRouteDependencies): void {
  app.post("/auth/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody("Request body is invalid"));
    }

    const passwordHash = await dependencies.passwordService.hash(parsed.data.password);
    try {
      const user = await dependencies.repository.createMerchantUser({
        merchantName: parsed.data.merchantName,
        email: parsed.data.email,
        passwordHash
      });
      const session = await dependencies.sessionService.issue(user);
      return reply.code(201).send({
        user: { id: user.id, merchantId: user.merchantId, email: user.email, role: user.role },
        token: session.token,
        expiresAt: session.expiresAt.toISOString()
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: { code: "EMAIL_ALREADY_REGISTERED", message: "Email is already registered" } });
      }
      request.log.error({ err: error }, "registration failed");
      return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Unable to register account" } });
    }
  });

  app.post("/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody("Request body is invalid"));
    }

    const user = await dependencies.repository.findUserByEmail(parsed.data.email);
    const valid = user
      ? await dependencies.passwordService.verify(user.passwordHash, parsed.data.password)
      : false;
    if (!user || !valid) {
      return reply.code(401).send(invalidCredentials);
    }

    const session = await dependencies.sessionService.issue(user);
    return reply.code(200).send({
      user: { id: user.id, merchantId: user.merchantId, email: user.email, role: user.role },
      token: session.token,
      expiresAt: session.expiresAt.toISOString()
    });
  });

  const requireAuth = createRequireAuth(dependencies.sessionService);
  app.get("/auth/me", { onRequest: requireAuth }, async (request: FastifyRequest) => {
    const user = request.auth;
    if (!user) {
      throw new Error("authentication guard did not attach identity");
    }
    return { user };
  });

  app.post("/auth/logout", { onRequest: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.auth;
    if (!user) {
      throw new Error("authentication guard did not attach identity");
    }
    await dependencies.sessionService.revoke(user.sessionId);
    return reply.code(204).send();
  });
}
