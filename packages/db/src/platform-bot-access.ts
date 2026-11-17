import type { PrismaClient } from "./generated/prisma/client.js";
import { runAsSystem } from "./row-security.js";

export type PlatformBotPermission = "use" | "edit" | "manage";
export type PlatformBotTenantScope = {
  spaceId: string;
  userId: string;
  companySpaceId: string;
  useBotIds: string[];
  editBotIds: string[];
  manageBotIds: string[];
  requiredPermission: PlatformBotPermission;
};
export type PlatformBotTenantResolution =
  | { kind: "not-company" }
  | { kind: "denied" }
  | { kind: "granted"; scope: PlatformBotTenantScope };

/**
 * Re-resolve a bot grant for background work. Call at job start so revocation
 * takes effect for queued work as well as new RPC requests. The result tells
 * callers whether ordinary tenant access applies or company access was denied.
 */
export async function resolvePlatformBotTenantScope(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    userId: string;
    botId: string;
    /** Every bot touched by a group job must be authorized before entering tenant scope. */
    botIds?: string[];
    requiredPermission: PlatformBotPermission;
  },
): Promise<PlatformBotTenantResolution> {
  return runAsSystem("re-resolve company bot grant for background work", async () => {
    const settings = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { companySpaceId: true },
    });
    const companySpaceId = settings?.companySpaceId;
    if (!companySpaceId || companySpaceId !== input.spaceId) return { kind: "not-company" };
    const [user, bot, membership, bots, grants] = await Promise.all([
      prisma.user.findUnique({
        where: { id: input.userId },
        select: {
          deactivatedAt: true,
          platformRole: true,
          platformMonitoringAcceptedAt: true,
          emailVerified: true,
        },
      }),
      prisma.bot.findUnique({
        where: { id: input.botId },
        select: { id: true, spaceId: true, userId: true },
      }),
      prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: input.spaceId, userId: input.userId } },
        select: { userId: true },
      }),
      prisma.bot.findMany({
        where: { spaceId: input.spaceId, archivedAt: null },
        select: { id: true, userId: true },
      }),
      prisma.platformBotGrant.findMany({
        where: { userId: input.userId, bot: { spaceId: input.spaceId, archivedAt: null } },
        select: { botId: true, permission: true },
      }),
    ]);
    const enrolled =
      user?.emailVerified &&
      (user.platformRole === "owner" ||
        ((user.platformRole === "admin" || user.platformRole === "member") &&
          user.platformMonitoringAcceptedAt !== null));
    if (
      !user ||
      user.deactivatedAt ||
      !enrolled ||
      !membership ||
      !bot ||
      bot.spaceId !== companySpaceId
    )
      return { kind: "denied" };

    const levels: Record<PlatformBotPermission, number> = { use: 1, edit: 2, manage: 3 };
    const permissionFor = (botId: string, ownerId: string): number => {
      if (
        user.platformRole === "owner" ||
        user.platformRole === "admin" ||
        ownerId === input.userId
      )
        return levels.manage;
      const permission = grants.find((candidate) => candidate.botId === botId)?.permission;
      return levels[permission as PlatformBotPermission] ?? 0;
    };
    const requestedBotIds = [...new Set([input.botId, ...(input.botIds ?? [])])];
    const requestedBots = bots.filter((candidate) => requestedBotIds.includes(candidate.id));
    if (
      requestedBots.length !== requestedBotIds.length ||
      requestedBots.some(
        (candidate) =>
          permissionFor(candidate.id, candidate.userId) < levels[input.requiredPermission],
      )
    )
      return { kind: "denied" };
    const useBotIds = bots
      .filter((candidate) => permissionFor(candidate.id, candidate.userId) >= levels.use)
      .map((candidate) => candidate.id);
    const editBotIds = bots
      .filter((candidate) => permissionFor(candidate.id, candidate.userId) >= levels.edit)
      .map((candidate) => candidate.id);
    const manageBotIds = bots
      .filter((candidate) => permissionFor(candidate.id, candidate.userId) >= levels.manage)
      .map((candidate) => candidate.id);
    return {
      kind: "granted",
      scope: {
        spaceId: input.spaceId,
        userId: input.userId,
        companySpaceId,
        useBotIds,
        editBotIds,
        manageBotIds,
        requiredPermission: input.requiredPermission,
      },
    };
  });
}
