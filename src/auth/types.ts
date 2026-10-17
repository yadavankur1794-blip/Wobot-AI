import type { FastifyRequest } from "fastify";

export type UserRole = "MERCHANT_USER" | "PLATFORM_STAFF";

export interface AuthenticatedUser {
  userId: string;
  merchantId: string | null;
  email: string;
  role: UserRole;
  sessionId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthenticatedUser | null;
  }
}

export type AuthenticatedRequest = FastifyRequest & { auth: AuthenticatedUser };
