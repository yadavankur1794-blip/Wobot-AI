import type { FastifyReply, FastifyRequest } from "fastify";

import type { SessionService } from "./sessions.js";
import type { AuthenticatedRequest } from "./types.js";

const unauthorizedBody = { error: { code: "UNAUTHENTICATED", message: "Authentication required" } };

export function createRequireAuth(sessionService: SessionService) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
    const user = token ? await sessionService.authenticate(token) : null;
    if (!user) {
      await reply.code(401).send(unauthorizedBody);
      return;
    }
    request.auth = user;
  };
}

export function requireMerchantAccess(request: AuthenticatedRequest, merchantId: string): boolean {
  return request.auth.role === "PLATFORM_STAFF" || request.auth.merchantId === merchantId;
}
