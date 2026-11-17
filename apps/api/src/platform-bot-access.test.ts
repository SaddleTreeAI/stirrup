import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rakazo/db", () => ({ runAsSystem: (_reason: string, work: () => unknown) => work() }));

import { requiredPlatformBotPermission, resolvePlatformBotScope } from "./platform-bot-access.js";

describe("company bot permission scope", () => {
  const actor: Actor = {
    userId: "member-1",
    spaceId: "company-space",
    email: "member@example.test",
    isDeploymentOwner: false,
  };
  const findSettings = vi.fn();
  const findGrants = vi.fn();
  const findUser = vi.fn();
  const findBots = vi.fn();
  const prisma = {
    deploymentSettings: { findUnique: findSettings },
    platformBotGrant: { findMany: findGrants },
    user: { findUnique: findUser },
    bot: { findMany: findBots },
  } as unknown as PrismaClient;

  beforeEach(() => {
    vi.clearAllMocks();
    findSettings.mockResolvedValue({ companySpaceId: "company-space" });
    findUser.mockResolvedValue({ platformRole: "member" });
    findBots.mockResolvedValue([]);
    findGrants.mockResolvedValue([
      { botId: "use-bot", permission: "use", bot: { spaceId: "company-space", userId: "other" } },
      { botId: "edit-bot", permission: "edit", bot: { spaceId: "company-space", userId: "other" } },
      {
        botId: "manage-bot",
        permission: "manage",
        bot: { spaceId: "company-space", userId: "other" },
      },
      {
        botId: "invalid-bot",
        permission: "owner",
        bot: { spaceId: "company-space", userId: "other" },
      },
    ]);
  });

  it("maps known operations and denies unknown bot-surface operations", () => {
    expect(requiredPlatformBotPermission(["threads", "send"])).toBe("use");
    expect(requiredPlatformBotPermission(["bots", "update"])).toBe("edit");
    expect(requiredPlatformBotPermission(["bots", "remove"])).toBe("manage");
    expect(requiredPlatformBotPermission(["computer", "futureMutation"])).toBe("deny");
    expect(requiredPlatformBotPermission(["connections", "revoke"])).toBe("use");
  });

  it("keeps personal spaces on their existing access behavior", async () => {
    await expect(
      resolvePlatformBotScope(prisma, { ...actor, spaceId: "personal-space" }, ["bots", "list"]),
    ).resolves.toBeNull();
    expect(findGrants).not.toHaveBeenCalled();
  });

  it("builds implied use/edit/manage sets from only the current member's company grants", async () => {
    await expect(resolvePlatformBotScope(prisma, actor, ["bots", "update"])).resolves.toEqual({
      spaceId: "company-space",
      userId: "member-1",
      companySpaceId: "company-space",
      useBotIds: ["use-bot", "edit-bot", "manage-bot"],
      editBotIds: ["edit-bot", "manage-bot"],
      manageBotIds: ["manage-bot"],
      requiredPermission: "edit",
    });
    expect(findGrants).toHaveBeenCalledWith({
      where: { userId: "member-1" },
      select: { botId: true, permission: true, bot: { select: { spaceId: true, userId: true } } },
    });
  });

  it("gives platform admins company bot administration but not personal Space access", async () => {
    findUser.mockResolvedValue({ platformRole: "admin" });
    findBots.mockResolvedValue([{ id: "company-bot" }]);
    findGrants.mockResolvedValue([]);
    await expect(resolvePlatformBotScope(prisma, actor, ["bots", "list"])).resolves.toMatchObject({
      useBotIds: ["company-bot"],
      editBotIds: ["company-bot"],
      manageBotIds: ["company-bot"],
      requiredPermission: "use",
    });
    await expect(
      resolvePlatformBotScope(prisma, { ...actor, spaceId: "personal-space" }, ["bots", "list"]),
    ).resolves.toBeNull();
  });

  it("lets the creator manage their bot while excluding grants for foreign Spaces", async () => {
    findGrants.mockResolvedValue([
      {
        botId: "foreign-bot",
        permission: "manage",
        bot: { spaceId: "other-space", userId: "member-1" },
      },
    ]);
    const findOwnedBots = vi.fn().mockResolvedValue([{ id: "created-bot" }]);
    (prisma as unknown as { bot: { findMany: typeof findOwnedBots } }).bot.findMany = findOwnedBots;
    await expect(
      resolvePlatformBotScope(prisma, actor, ["threads", "send"]),
    ).resolves.toMatchObject({
      useBotIds: ["created-bot"],
      editBotIds: ["created-bot"],
      manageBotIds: ["created-bot"],
    });
  });
});
