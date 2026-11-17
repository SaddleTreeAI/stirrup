import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { authorizePlatformInspection } from "./platform-admin.js";

function prismaFor(roles: Record<string, string>) {
  return {
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ platformMode: true })),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const role = roles[where.id];
        return role
          ? {
              id: where.id,
              platformRole: role,
              platformMonitoringAcceptedAt: new Date(),
              emailVerified: true,
              deactivatedAt: null,
            }
          : null;
      }),
    },
  } as unknown as PrismaClient;
}

describe("platform bot inspection authorization", () => {
  it("allows the platform owner and refuses administrators and members", async () => {
    const prisma = prismaFor({
      owner: "owner",
      admin: "admin",
      member: "member",
      target: "member",
    });

    await expect(
      authorizePlatformInspection(prisma, "owner", "target", "bot-content"),
    ).resolves.toBeUndefined();
    await expect(
      authorizePlatformInspection(prisma, "admin", "target", "bot-content"),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await expect(
      authorizePlatformInspection(prisma, "member", "target", "bot-content"),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});
