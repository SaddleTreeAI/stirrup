import type { PrismaClient } from "./client.js";

export type RowSecurityTenant = {
  name: string;
  userId: string;
  spaceId: string;
  botId: string;
  threadId: string;
  documentId?: string;
  secretId?: string;
  personalSecretId?: string;
};

export async function createRowSecurityTenants(
  owner: PrismaClient,
  suffix: string,
  names: readonly string[] = ["a", "b"],
) {
  const organizationId = `rls-org-${suffix}`;
  const tenants = names.map((name) => ({
    name,
    userId: `rls-user-${name}-${suffix}`,
    spaceId: `rls-space-${name}-${suffix}`,
    botId: `rls-bot-${name}-${suffix}`,
    threadId: `rls-thread-${name}-${suffix}`,
    documentId: `rls-doc-${name}-${suffix}`,
    secretId: `rls-secret-${name}-${suffix}`,
    personalSecretId: `rls-personal-${name}-${suffix}`,
  }));

  await owner.organization.create({
    data: { id: organizationId, name: "RLS", slug: organizationId, createdAt: new Date() },
  });
  for (const tenant of tenants) {
    await owner.user.create({
      data: {
        id: tenant.userId,
        name: tenant.name,
        email: `${tenant.userId}@rakazo.test`,
        emailVerified: true,
      },
    });
    await owner.space.create({
      data: { id: tenant.spaceId, organizationId, name: tenant.name },
    });
    await owner.bot.create({
      data: {
        id: tenant.botId,
        spaceId: tenant.spaceId,
        userId: tenant.userId,
        name: tenant.name,
        color: "#000",
      },
    });
    await owner.thread.create({
      data: {
        id: tenant.threadId,
        spaceId: tenant.spaceId,
        userId: tenant.userId,
        botId: tenant.botId,
      },
    });
    await owner.member.create({
      data: {
        id: `${tenant.userId}-member`,
        organizationId,
        userId: tenant.userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await owner.spaceMember.create({
      data: {
        id: `${tenant.userId}-space-member`,
        spaceId: tenant.spaceId,
        userId: tenant.userId,
        organizationId,
        role: "owner",
        createdAt: new Date(),
      },
    });
  }
  return { organizationId, tenants };
}
