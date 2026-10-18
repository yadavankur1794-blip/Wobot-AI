import { createHash, randomBytes } from "node:crypto";

import type { AuthRepository } from "./repository.js";
import type { AuthenticatedUser } from "./types.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionService {
  issue(user: { id: string }): Promise<{ token: string; expiresAt: Date }>;
  authenticate(token: string): Promise<AuthenticatedUser | null>;
  revoke(sessionId: string): Promise<void>;
}

export function hashSessionToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function createSessionService(repository: AuthRepository): SessionService {
  return {
    async issue(user) {
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      await repository.createSession({ userId: user.id, tokenHash: hashSessionToken(token), expiresAt });
      return { token, expiresAt };
    },
    async authenticate(token) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
        return null;
      }
      const session = await repository.findSessionByTokenHash(hashSessionToken(token));
      return session
        ? {
            userId: session.userId,
            merchantId: session.merchantId,
            email: session.email,
            role: session.role,
            sessionId: session.id
          }
        : null;
    },
    revoke: (sessionId) => repository.revokeSession(sessionId)
  };
}
