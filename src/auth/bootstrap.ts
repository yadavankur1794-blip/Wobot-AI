import { z } from "zod";

const bootstrapSchema = z.object({
  STAFF_BOOTSTRAP_ENABLED: z.literal("true"),
  STAFF_BOOTSTRAP_SECRET: z.string().min(32),
  STAFF_BOOTSTRAP_CONFIRM: z.literal("I_UNDERSTAND"),
  STAFF_EMAIL: z.email(),
  STAFF_PASSWORD: z.string().min(12).max(128)
}).strict();

export type BootstrapConfig = z.infer<typeof bootstrapSchema>;

export function parseBootstrapEnvironment(environment: NodeJS.ProcessEnv): BootstrapConfig {
  return bootstrapSchema.parse({
    STAFF_BOOTSTRAP_ENABLED: environment.STAFF_BOOTSTRAP_ENABLED,
    STAFF_BOOTSTRAP_SECRET: environment.STAFF_BOOTSTRAP_SECRET,
    STAFF_BOOTSTRAP_CONFIRM: environment.STAFF_BOOTSTRAP_CONFIRM,
    STAFF_EMAIL: environment.STAFF_EMAIL,
    STAFF_PASSWORD: environment.STAFF_PASSWORD
  });
}
