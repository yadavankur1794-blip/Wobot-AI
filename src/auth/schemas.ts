import { z } from "zod";

const emailSchema = z.email().transform((email) => email.trim().toLowerCase());

export const registerSchema = z.object({
  merchantName: z.string().trim().min(1).max(200),
  email: emailSchema,
  password: z.string().min(12).max(128)
}).strict();

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128)
}).strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
