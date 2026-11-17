import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { resolveModelKey } from "./run-model.js";

describe("company model credential isolation", () => {
  it("does not substitute an instance key when a selected personal secret is missing", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "openrouter");
    vi.stubEnv("PI_DEFAULT_MODEL", "model-a");
    try {
      const settings = { platformMode: true };
      const prisma = {
        deploymentSettings: { findUnique: vi.fn(async () => settings) },
        secret: { findFirst: vi.fn(async () => null) },
      } as unknown as PrismaClient;

      await expect(
        resolveModelKey(
          {
            prisma,
            deploymentModelKey: "owner-instance-key",
            secretStore: { load: vi.fn(), put: vi.fn() },
          } as never,
          "staff-user",
          "company-space",
          {
            id: "selected-personal-connection",
            secretId: "deleted-personal-secret",
            provider: "openrouter",
          },
          "openrouter",
          "model-a",
        ),
      ).rejects.toThrow("The saved credential is no longer available.");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("preserves the ordinary deployment-key fallback for a missing saved key", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "openrouter");
    vi.stubEnv("PI_DEFAULT_MODEL", "model-a");
    try {
      const prisma = {
        deploymentSettings: { findUnique: vi.fn(async () => ({ platformMode: false })) },
        secret: { findFirst: vi.fn(async () => null) },
      } as unknown as PrismaClient;

      await expect(
        resolveModelKey(
          {
            prisma,
            deploymentModelKey: "instance-key",
            secretStore: { load: vi.fn(), put: vi.fn() },
          } as never,
          "user",
          "space",
          {
            id: "selected-personal-connection",
            secretId: "deleted-personal-secret",
            provider: "openrouter",
          },
          "openrouter",
          "model-a",
        ),
      ).resolves.toMatchObject({ apiKey: "instance-key" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
