import { describe, expect, it } from "vitest";

import { parseBootstrapEnvironment } from "../src/auth/bootstrap.js";

describe("staff bootstrap configuration", () => {
  it("ignores unrelated process environment variables while keeping strict bootstrap validation", () => {
    const config = parseBootstrapEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://example.invalid/catalog",
      HOSTNAME: "container-id",
      STAFF_BOOTSTRAP_ENABLED: "true",
      STAFF_BOOTSTRAP_SECRET: "a-secure-bootstrap-secret-with-at-least-32-characters",
      STAFF_BOOTSTRAP_CONFIRM: "I_UNDERSTAND",
      STAFF_EMAIL: "staff@example.com",
      STAFF_PASSWORD: "a long temporary password"
    });

    expect(config).toEqual({
      STAFF_BOOTSTRAP_ENABLED: "true",
      STAFF_BOOTSTRAP_SECRET: "a-secure-bootstrap-secret-with-at-least-32-characters",
      STAFF_BOOTSTRAP_CONFIRM: "I_UNDERSTAND",
      STAFF_EMAIL: "staff@example.com",
      STAFF_PASSWORD: "a long temporary password"
    });
  });

  it("rejects missing bootstrap controls", () => {
    expect(() => parseBootstrapEnvironment({
      STAFF_EMAIL: "staff@example.com",
      STAFF_PASSWORD: "a long temporary password"
    })).toThrow();
  });
});
