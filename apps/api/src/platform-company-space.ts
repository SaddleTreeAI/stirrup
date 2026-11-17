import { randomUUID } from "node:crypto";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, recordAuditEvent, runAsSystem, withTransactionRetry } from "@rakazo/db";

type PlatformSpacePrisma = Pick<
  PrismaClient,
  | "deploymentSettings"
  | "organization"
  | "member"
  | "space"
  | "spaceMember"
  | "user"
  | "$transaction"
>;

type PlatformCompanyUser = {
  id: string;
  platformRole: string;
  platformMonitoringAcceptedAt: Date | null;
  emailVerified: boolean;
  deactivatedAt: Date | null;
};

export function isPlatformCompanyUser(user: PlatformCompanyUser): boolean {
  if (user.deactivatedAt || !user.emailVerified) return false;
  if (user.platformRole === "owner") return true;
  return (
    (user.platformRole === "admin" || user.platformRole === "member") &&
    user.platformMonitoringAcceptedAt !== null
  );
}

export async function getPlatformCompanySpace(prisma: PlatformSpacePrisma) {
  return runAsSystem("read the configured platform company Space", async () => {
    const settings = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { companySpaceId: true },
    });
    if (!settings?.companySpaceId) return null;
    const space = await prisma.space.findUnique({
      where: { id: settings.companySpaceId },
      select: {
        id: true,
        name: true,
        _count: { select: { memberships: true, bots: true } },
      },
    });
    if (!space) return null;
    return {
      id: space.id,
      name: space.name,
      memberCount: space._count.memberships,
      botCount: space._count.bots,
    };
  });
}

/**
 * Designates the one company Space. `spaceId` adopts an existing owner-created Space without
 * changing its ID or content; it is accepted only when every current member is a platform user.
 */
export async function setupPlatformCompanySpace(
  prisma: PlatformSpacePrisma,
  actorUserId: string,
  targetSpaceId?: string,
) {
  const configured = await runAsSystem("configure the platform company Space", async () =>
    withTransactionRetry(() =>
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rakazo:company-space'))`;
          const [settings, owner] = await Promise.all([
            tx.deploymentSettings.findUnique({
              where: { id: "default" },
              select: { companySpaceId: true },
            }),
            tx.user.findUnique({
              where: { id: actorUserId },
              select: {
                id: true,
                platformRole: true,
                platformMonitoringAcceptedAt: true,
                emailVerified: true,
                deactivatedAt: true,
              },
            }),
          ]);
          if (owner?.platformRole !== "owner" || !isPlatformCompanyUser(owner))
            throw new ClientError(
              "FORBIDDEN",
              "Only a platform owner can configure the company Space",
            );
          if (settings?.companySpaceId) {
            if (targetSpaceId && targetSpaceId !== settings.companySpaceId)
              throw new ClientError("CONFLICT", "A company Space is already configured");
            return settings.companySpaceId;
          }

          const createdAt = new Date();
          const spaceId = targetSpaceId ?? randomUUID();
          const organizationId = randomUUID();
          if (targetSpaceId) {
            const space = await tx.space.findUnique({
              where: { id: targetSpaceId },
              select: { id: true, createdByUserId: true },
            });
            if (!space || space.createdByUserId !== actorUserId)
              throw new ClientError("NOT_FOUND", "Choose a Space created by this owner");
            const memberships = await tx.spaceMember.findMany({
              where: { spaceId: targetSpaceId },
              select: {
                userId: true,
                member: {
                  select: {
                    user: {
                      select: {
                        id: true,
                        platformRole: true,
                        platformMonitoringAcceptedAt: true,
                        emailVerified: true,
                        deactivatedAt: true,
                      },
                    },
                  },
                },
              },
            });
            if (
              memberships.some((membership) => !isPlatformCompanyUser(membership.member.user)) ||
              !memberships.some((membership) => membership.userId === actorUserId)
            ) {
              throw new ClientError(
                "CONFLICT",
                "That Space has members outside this platform or is not owned by this account",
              );
            }
          }
          await tx.organization.create({
            data: {
              id: organizationId,
              name: "Company",
              slug: `company-${organizationId}`,
              createdAt,
            },
          });
          if (!targetSpaceId) {
            await tx.space.create({
              data: {
                id: spaceId,
                organizationId,
                name: "Company",
                isDefault: true,
                createdByUserId: actorUserId,
                createdAt,
              },
            });
          }

          const platformUsers = await tx.user.findMany({
            where: {
              deactivatedAt: null,
              emailVerified: true,
              OR: [{ platformRole: "owner" }, { platformMonitoringAcceptedAt: { not: null } }],
            },
            select: { id: true, platformRole: true },
          });
          if (!platformUsers.some((user) => user.id === actorUserId))
            throw new ClientError("FORBIDDEN", "The owner is not an active platform account");

          for (const user of platformUsers) {
            const organizationRole = user.platformRole === "owner" ? "owner" : "member";
            await tx.member.upsert({
              where: { organizationId_userId: { organizationId, userId: user.id } },
              create: {
                id: randomUUID(),
                organizationId,
                userId: user.id,
                role: organizationRole,
                createdAt,
              },
              update: { role: organizationRole },
            });
          }

          if (targetSpaceId) {
            // Move the existing, owner-created Space into a dedicated company Organization after
            // creating its new organization memberships. The composite FK cascades organizationId
            // to SpaceMember without changing Space IDs, encrypted content, or its Space key.
            await tx.space.update({
              where: { id: targetSpaceId },
              data: { organizationId },
            });
          }

          for (const user of platformUsers) {
            const spaceRole = user.platformRole === "owner" ? "owner" : "member";
            await tx.spaceMember.upsert({
              where: { spaceId_userId: { spaceId, userId: user.id } },
              create: {
                id: randomUUID(),
                spaceId,
                organizationId,
                userId: user.id,
                role: spaceRole,
                createdAt,
              },
              update: { organizationId, role: spaceRole },
            });
          }
          await tx.deploymentSettings.upsert({
            where: { id: "default" },
            create: { id: "default", companySpaceId: spaceId },
            update: { companySpaceId: spaceId },
          });
          return spaceId;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ),
  );
  await recordAuditEvent({
    action: "platform.company_space.configured",
    actor: { type: "user", id: actorUserId },
    spaceId: configured,
    target: { type: "space", id: configured, label: "Company" },
  });
  const result = await getPlatformCompanySpace(prisma);
  if (!result) throw new Error("Company Space was not saved after configuration");
  return result;
}

/** Adds an invited platform account to the Company Space on its next authenticated API request. */
export async function ensurePlatformCompanyMembership(
  prisma: Pick<
    PlatformSpacePrisma,
    "deploymentSettings" | "space" | "spaceMember" | "member" | "user" | "$transaction"
  >,
  userId: string,
): Promise<void> {
  await runAsSystem("join an authenticated platform user to the company Space", async () => {
    const settings = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { companySpaceId: true },
    });
    const companySpaceId = settings?.companySpaceId;
    if (!companySpaceId) return;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        platformRole: true,
        platformMonitoringAcceptedAt: true,
        emailVerified: true,
        deactivatedAt: true,
      },
    });
    if (!user || !isPlatformCompanyUser(user)) return;
    const space = await prisma.space.findUnique({
      where: { id: companySpaceId },
      select: { organizationId: true },
    });
    if (!space) return;
    const existing = await prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: companySpaceId, userId } },
      select: { id: true },
    });
    if (existing) return;
    const memberRole = user.platformRole === "owner" ? "owner" : "member";
    await prisma.$transaction(async (tx) => {
      await tx.member.upsert({
        where: { organizationId_userId: { organizationId: space.organizationId, userId } },
        create: {
          id: randomUUID(),
          organizationId: space.organizationId,
          userId,
          role: memberRole,
          createdAt: new Date(),
        },
        update: { role: memberRole },
      });
      await tx.spaceMember.upsert({
        where: { spaceId_userId: { spaceId: companySpaceId, userId } },
        create: {
          id: randomUUID(),
          spaceId: companySpaceId,
          organizationId: space.organizationId,
          userId,
          role: memberRole,
          createdAt: new Date(),
        },
        update: { organizationId: space.organizationId, role: memberRole },
      });
    });
  });
}
