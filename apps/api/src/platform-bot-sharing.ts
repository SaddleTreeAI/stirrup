import type { BotAccessState, BotPermission, PlatformRole } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { recordAuditEvent, runAsSystem } from "@rakazo/db";

type AccessPrisma = Pick<
  PrismaClient,
  "deploymentSettings" | "platformBotGrant" | "spaceMember" | "bot" | "user" | "$transaction"
>;

async function accessBot(prisma: AccessPrisma, botId: string, userId: string) {
  return runAsSystem("resolve company bot sharing", async () => {
    const [settings, bot, grant] = await Promise.all([
      prisma.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { companySpaceId: true },
      }),
      prisma.bot.findUnique({
        where: { id: botId },
        select: { id: true, spaceId: true, userId: true },
      }),
      prisma.platformBotGrant.findUnique({
        where: { botId_userId: { botId, userId } },
        select: { permission: true },
      }),
    ]);
    const roleRow = await prisma.user.findUnique({
      where: { id: userId },
      select: { platformRole: true },
    });
    const platformRole = roleRow?.platformRole as PlatformRole | undefined;
    const isCompanyBot = Boolean(bot && settings?.companySpaceId === bot.spaceId);
    const isAdmin = platformRole === "owner" || platformRole === "admin";
    const isCreator = bot?.userId === userId;
    const canManage = isCompanyBot && (isAdmin || isCreator || grant?.permission === "manage");
    const permission = (grant?.permission ?? (isAdmin || isCreator ? "manage" : undefined)) as
      | BotPermission
      | undefined;
    return { bot, isCompanyBot, permission, canManage, platformRole };
  });
}

export async function listBotAccess(
  prisma: AccessPrisma,
  botId: string,
  actorUserId: string,
): Promise<BotAccessState> {
  const access = await accessBot(prisma, botId, actorUserId);
  if (!access.bot) throw new ClientError("NOT_FOUND", "Bot not found");
  if (!access.isCompanyBot)
    return { isCompanyBot: false, permission: null, canManage: false, members: [] };
  if (!access.permission && !access.canManage && access.bot.userId !== actorUserId)
    throw new ClientError("FORBIDDEN", "You do not have access to this bot");
  if (!access.canManage)
    return {
      isCompanyBot: true,
      permission: access.permission ?? null,
      canManage: false,
      members: [],
    };
  const rows = await runAsSystem("list company bot sharing members", async () => {
    const companySpace = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { companySpaceId: true },
    });
    const companySpaceId = companySpace?.companySpaceId;
    if (!companySpaceId) return [];
    const memberships = await prisma.spaceMember.findMany({
      where: { spaceId: companySpaceId },
      select: { userId: true },
      orderBy: { createdAt: "asc" },
    });
    const users = await prisma.user.findMany({
      where: { id: { in: memberships.map(({ userId }) => userId) } },
      select: { id: true, name: true, email: true, platformRole: true },
    });
    const userById = new Map(users.map((user) => [user.id, user]));
    const grants = await prisma.platformBotGrant.findMany({
      where: { botId },
      select: { userId: true, permission: true },
    });
    const byUser = new Map(
      grants.map((grant) => [grant.userId, grant.permission as BotPermission]),
    );
    return memberships.flatMap(({ userId }) => {
      const user = userById.get(userId);
      return user
        ? [
            {
              userId,
              name: user.name,
              email: user.email,
              role: user.platformRole as PlatformRole,
              permission: byUser.get(userId) ?? null,
            },
          ]
        : [];
    });
  });
  return {
    isCompanyBot: true,
    permission: access.permission ?? null,
    canManage: true,
    members: rows,
  };
}

async function changeBotAccess(
  prisma: AccessPrisma,
  actorUserId: string,
  botId: string,
  targetUserId: string,
  permission: BotPermission | null,
): Promise<BotAccessState> {
  const access = await accessBot(prisma, botId, actorUserId);
  if (!access.bot) throw new ClientError("NOT_FOUND", "Bot not found");
  if (!access.isCompanyBot)
    throw new ClientError("BAD_REQUEST", "Sharing is only available for company bots");
  if (!access.canManage)
    throw new ClientError("FORBIDDEN", "Only a company bot manager can change access");
  if (targetUserId === access.bot.userId && permission === null)
    throw new ClientError("BAD_REQUEST", "The bot owner must keep access");

  await runAsSystem("change company bot sharing", async () => {
    const targetMembership = await prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: access.bot?.spaceId ?? "", userId: targetUserId } },
      select: { id: true },
    });
    if (!targetMembership) throw new ClientError("NOT_FOUND", "Company member not found");
    await prisma.$transaction(async (tx) => {
      if (permission === null) {
        await tx.platformBotGrant.deleteMany({ where: { botId, userId: targetUserId } });
      } else {
        await tx.platformBotGrant.upsert({
          where: { botId_userId: { botId, userId: targetUserId } },
          create: { botId, userId: targetUserId, permission, createdByUserId: actorUserId },
          update: { permission, createdByUserId: actorUserId },
        });
      }
    });
  });
  await recordAuditEvent({
    action: permission ? "platform.bot_access.granted" : "platform.bot_access.revoked",
    actor: { type: "user", id: actorUserId },
    spaceId: access.bot.spaceId,
    target: { type: "bot", id: botId },
    metadata: { targetUserId, permission },
  });
  return listBotAccess(prisma, botId, actorUserId);
}

export function setBotAccess(
  prisma: AccessPrisma,
  actorUserId: string,
  botId: string,
  targetUserId: string,
  permission: BotPermission,
) {
  return changeBotAccess(prisma, actorUserId, botId, targetUserId, permission);
}

export function revokeBotAccess(
  prisma: AccessPrisma,
  actorUserId: string,
  botId: string,
  targetUserId: string,
) {
  return changeBotAccess(prisma, actorUserId, botId, targetUserId, null);
}
