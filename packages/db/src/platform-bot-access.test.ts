import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./generated/prisma/client.js";
import { resolvePlatformBotTenantScope } from "./platform-bot-access.js";

function fixture(
  overrides: {
    companySpaceId?: string | null;
    active?: boolean;
    role?: string;
    botSpaceId?: string;
    botOwnerId?: string;
    grant?: string | null;
    member?: boolean;
    consent?: boolean;
    verified?: boolean;
    bots?: Array<{ id: string; userId: string }>;
    grants?: Array<{ botId: string; permission: string }>;
  } = {},
) {
  const prisma = {
    deploymentSettings: {
      findUnique: vi.fn().mockResolvedValue({
        companySpaceId:
          overrides.companySpaceId === undefined ? "company" : overrides.companySpaceId,
      }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        deactivatedAt: overrides.active === false ? new Date() : null,
        platformRole: overrides.role ?? "member",
        platformMonitoringAcceptedAt: overrides.consent === false ? null : new Date(),
        emailVerified: overrides.verified !== false,
      }),
    },
    bot: {
      findUnique: vi.fn().mockResolvedValue({
        id: "bot",
        spaceId: overrides.botSpaceId ?? "company",
        userId: overrides.botOwnerId ?? "bot-owner",
      }),
      findMany: vi
        .fn()
        .mockResolvedValue(
          overrides.bots ?? [{ id: "bot", userId: overrides.botOwnerId ?? "bot-owner" }],
        ),
    },
    platformBotGrant: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          overrides.grant === null ? null : { permission: overrides.grant ?? "manage" },
        ),
      findMany: vi
        .fn()
        .mockResolvedValue(
          overrides.grants ??
            (overrides.grant === null
              ? []
              : [{ botId: "bot", permission: overrides.grant ?? "manage" }]),
        ),
    },
    spaceMember: {
      findUnique: vi
        .fn()
        .mockResolvedValue(overrides.member === false ? null : { userId: "member" }),
    },
  };
  return prisma as unknown as PrismaClient;
}

describe("resolvePlatformBotTenantScope", () => {
  it("returns only the current user's explicitly granted bot permission", async () => {
    const prisma = fixture({ grant: "manage" });
    await expect(
      resolvePlatformBotTenantScope(prisma, {
        spaceId: "company",
        userId: "member",
        botId: "bot",
        requiredPermission: "edit",
      }),
    ).resolves.toEqual({
      kind: "granted",
      scope: {
        spaceId: "company",
        userId: "member",
        companySpaceId: "company",
        useBotIds: ["bot"],
        editBotIds: ["bot"],
        manageBotIds: ["bot"],
        requiredPermission: "edit",
      },
    });
  });

  it.each([
    ["bot belongs to another Space", fixture({ botSpaceId: "other" })],
    ["grant was revoked", fixture({ grant: null })],
    ["user was deactivated", fixture({ active: false })],
    ["staff user did not accept monitoring", fixture({ consent: false })],
    ["account email is not verified", fixture({ verified: false })],
    ["grant is below the required permission", fixture({ grant: "use" })],
  ])("returns denied when %s", async (_reason, prisma) => {
    await expect(
      resolvePlatformBotTenantScope(prisma, {
        spaceId: "company",
        userId: "member",
        botId: "bot",
        requiredPermission: "edit",
      }),
    ).resolves.toEqual({ kind: "denied" });
  });

  it("returns not-company only for a Space outside the configured company Space", async () => {
    await expect(
      resolvePlatformBotTenantScope(fixture({ companySpaceId: null }), {
        spaceId: "company",
        userId: "member",
        botId: "bot",
        requiredPermission: "use",
      }),
    ).resolves.toEqual({ kind: "not-company" });
  });

  it("allows owners and admins to manage company bots", async () => {
    await expect(
      resolvePlatformBotTenantScope(fixture({ role: "owner", grant: null }), {
        spaceId: "company",
        userId: "owner",
        botId: "bot",
        requiredPermission: "manage",
      }),
    ).resolves.toMatchObject({ kind: "granted", scope: { manageBotIds: ["bot"] } });
    await expect(
      resolvePlatformBotTenantScope(fixture({ role: "admin", grant: null }), {
        spaceId: "company",
        userId: "admin",
        botId: "bot",
        requiredPermission: "manage",
      }),
    ).resolves.toMatchObject({ kind: "granted", scope: { manageBotIds: ["bot"] } });
  });

  it("lets the creator manage their bot without a separate grant", async () => {
    await expect(
      resolvePlatformBotTenantScope(fixture({ botOwnerId: "member", grant: null }), {
        spaceId: "company",
        userId: "member",
        botId: "bot",
        requiredPermission: "manage",
      }),
    ).resolves.toMatchObject({ kind: "granted", scope: { manageBotIds: ["bot"] } });
  });

  it("requires active Space membership and permission on every group bot", async () => {
    const notMember = fixture({ member: false });
    await expect(
      resolvePlatformBotTenantScope(notMember, {
        spaceId: "company",
        userId: "member",
        botId: "bot",
        requiredPermission: "use",
      }),
    ).resolves.toEqual({ kind: "denied" });

    const group = fixture({
      grant: "use",
      bots: [
        { id: "bot", userId: "bot-owner" },
        { id: "other", userId: "other-owner" },
      ],
      grants: [
        { botId: "bot", permission: "use" },
        { botId: "other", permission: "edit" },
      ],
    });
    await expect(
      resolvePlatformBotTenantScope(group, {
        spaceId: "company",
        userId: "member",
        botId: "bot",
        botIds: ["other"],
        requiredPermission: "use",
      }),
    ).resolves.toMatchObject({
      kind: "granted",
      scope: { useBotIds: ["bot", "other"], editBotIds: ["other"] },
    });
    await expect(
      resolvePlatformBotTenantScope(group, {
        spaceId: "company",
        userId: "member",
        botId: "bot",
        botIds: ["ungranted"],
        requiredPermission: "use",
      }),
    ).resolves.toEqual({ kind: "denied" });
  });
});
