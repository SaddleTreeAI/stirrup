import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { createGroupRepos } from "./groups.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsTenant, runAsTenantWithPlatformBots } from "./row-security.js";
import { createRowSecurityTenants } from "./row-security-test-fixture.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("company bot row-level security (PostgreSQL)", () => {
  const suffix = `company-${process.pid}-${Date.now()}`;
  let owner: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createDb>;
  let db: PrismaClient;
  let system: PrismaClient;
  let organizationId: string;
  let tenants: Awaited<ReturnType<typeof createRowSecurityTenants>>["tenants"];
  let a: (typeof tenants)[number];
  let b: (typeof tenants)[number];

  beforeAll(async () => {
    owner = createDb(migrationUrl!);
    app = createDb(runtimeUrl!, { poolMax: 4 });
    db = app.prisma;
    system = asSystem(owner.prisma, "company RLS test fixture and assertions");
    const fixture = await createRowSecurityTenants(system, suffix);
    organizationId = fixture.organizationId;
    tenants = fixture.tenants;
    [a, b] = tenants as [typeof a, typeof b];
  });

  afterAll(async () => {
    if (owner) {
      await system.organization.deleteMany({ where: { id: organizationId } });
      await system.user.deleteMany({ where: { id: { in: tenants.map((t) => t.userId) } } });
      for (const handle of [owner, app]) {
        await handle.prisma.$disconnect();
        await handle.pool.end();
      }
    }
  });

  it("fences company bots and their threads by the permission resolved for the request", async () => {
    const settingsBefore = await system.deploymentSettings.findUnique({
      where: { id: "default" },
    });
    const privateBotId = `rls-company-private-${suffix}`;
    const privateThreadId = `rls-company-private-thread-${suffix}`;
    const privateComputerId = `rls-company-private-computer-${suffix}`;
    const grantId = `rls-company-grant-${suffix}`;
    const companySectionId = `rls-company-section-created-${suffix}`;
    const ordinarySectionId = `rls-ordinary-section-created-${suffix}`;
    let companyBoardId: string;
    let createdCompanyBoard = false;
    const companyTicketId = `rls-company-ticket-${suffix}`;
    const crossSpaceGroupId = `rls-company-cross-space-group-${suffix}`;
    const ordinarySecondBotId = `rls-ordinary-group-bot-${suffix}`;
    const crossSpaceMemberId = `rls-company-member-${suffix}`;
    await system.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", companySpaceId: a.spaceId },
      update: { companySpaceId: a.spaceId },
    });
    await system.computer.create({
      data: {
        id: privateComputerId,
        spaceId: a.spaceId,
        userId: a.userId,
        scope: "dedicated",
        scopeKey: `bot:${privateBotId}`,
        homeKey: `rls-company-private-home-${suffix}`,
        kind: "fake",
      },
    });
    await system.bot.create({
      data: {
        id: privateBotId,
        spaceId: a.spaceId,
        userId: a.userId,
        name: "private",
        color: "#000",
        computerId: privateComputerId,
      },
    });
    await system.thread.create({
      data: { id: privateThreadId, spaceId: a.spaceId, userId: a.userId, botId: privateBotId },
    });
    await system.platformBotGrant.create({
      data: {
        id: grantId,
        botId: a.botId,
        userId: b.userId,
        permission: "manage",
        createdByUserId: a.userId,
      },
    });
    await system.spaceMember.create({
      data: {
        id: crossSpaceMemberId,
        spaceId: a.spaceId,
        userId: b.userId,
        organizationId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const existingCompanyBoard = await system.board.findUnique({
      where: { spaceId: a.spaceId },
      select: { id: true },
    });
    if (existingCompanyBoard) {
      companyBoardId = existingCompanyBoard.id;
    } else {
      companyBoardId = `rls-company-board-${suffix}`;
      await system.board.create({ data: { id: companyBoardId, spaceId: a.spaceId } });
      createdCompanyBoard = true;
    }
    const previousTicket = await system.ticket.aggregate({
      where: { boardId: companyBoardId },
      _max: { number: true },
    });
    const ticketNumber = (previousTicket._max.number ?? 0) + 1;
    const scope = {
      spaceId: a.spaceId,
      userId: b.userId,
      companySpaceId: a.spaceId,
      useBotIds: [a.botId],
      editBotIds: [],
      manageBotIds: [],
      requiredPermission: "use" as const,
    };
    const manageScope = {
      ...scope,
      useBotIds: [a.botId],
      editBotIds: [a.botId],
      manageBotIds: [a.botId],
      requiredPermission: "manage" as const,
    };
    const createdBotId = `rls-company-created-${suffix}`;
    const createdComputerId = `rls-company-computer-${suffix}`;
    let repoCreatedCompanyBotId: string | undefined;
    let repoCreatedOrdinaryBotId: string | undefined;
    let companyGroupId: string | undefined;
    let ordinaryGroupId: string | undefined;
    let createdCrossSpaceGroup = false;
    try {
      const allowed = await runAsTenantWithPlatformBots(scope, async () => {
        const bots = await db.bot.findMany({
          where: { id: { in: [a.botId, privateBotId] } },
          select: { id: true },
        });
        const threads = await db.thread.findMany({
          where: { id: { in: [a.threadId, privateThreadId] } },
          select: { id: true },
        });
        const computers = await db.computer.findMany({
          where: { id: privateComputerId },
          select: { id: true },
        });
        const nested = await runAsTenant({ spaceId: a.spaceId, userId: b.userId }, () =>
          db.bot.findMany({ where: { id: { in: [a.botId, privateBotId] } }, select: { id: true } }),
        );
        const otherIdentity = await runAsTenant({ spaceId: a.spaceId, userId: a.userId }, () =>
          db.bot.findMany({ where: { id: { in: [a.botId, privateBotId] } }, select: { id: true } }),
        );
        const write = await db.bot.updateMany({
          where: { id: a.botId },
          data: { name: "not allowed" },
        });
        return { bots, threads, computers, nested, otherIdentity, write };
      });
      expect(allowed.bots.map((row) => row.id)).toEqual([a.botId]);
      expect(allowed.threads.map((row) => row.id)).toEqual([a.threadId]);
      expect(allowed.computers).toEqual([]);
      expect(allowed.nested.map((row) => row.id)).toEqual([a.botId]);
      expect(allowed.otherIdentity).toEqual([]);
      expect(allowed.write.count).toBe(0);
      const created = await runAsTenantWithPlatformBots(manageScope, async () => {
        const computer = await db.computer.create({
          data: {
            id: createdComputerId,
            spaceId: a.spaceId,
            userId: b.userId,
            scope: "dedicated",
            scopeKey: `bot:${createdBotId}`,
            homeKey: `rls-company-home-${suffix}`,
            kind: "fake",
          },
        });
        const bot = await db.bot.create({
          data: {
            id: createdBotId,
            spaceId: a.spaceId,
            userId: b.userId,
            name: "created in company Space",
            color: "#000",
            computerId: computer.id,
          },
        });
        return {
          bot,
          visibleComputer: await db.computer.findUnique({
            where: { id: computer.id },
            select: { id: true },
          }),
        };
      });
      expect(created.bot.id).toBe(createdBotId);
      expect(created.visibleComputer?.id).toBe(createdComputerId);

      // Exercise the actual repository flow. Its bot.create uses Prisma's
      // INSERT ... RETURNING, which evaluates the restrictive SELECT policy
      // against the new row before a separate lookup can find it.
      const repos = createRepos(db);
      const actorA = {
        userId: a.userId,
        spaceId: a.spaceId,
        email: `${a.userId}@rakazo.test`,
        isDeploymentOwner: false,
      };
      const companyRepoBot = await runAsTenantWithPlatformBots(
        { ...manageScope, userId: a.userId },
        () =>
          repos.createBot(actorA, {
            id: `rls-company-repo-created-${suffix}`,
            name: "Company repository bot",
            description: "",
            instructions: "",
            notifyOnFinish: false,
            computerMode: "dedicated",
          }),
      );
      repoCreatedCompanyBotId = companyRepoBot.id;
      expect(companyRepoBot.id).toBe(`rls-company-repo-created-${suffix}`);

      const groupRepos = createGroupRepos(db);
      const companyActor = {
        userId: a.userId,
        spaceId: a.spaceId,
        email: `${a.userId}@rakazo.test`,
        isDeploymentOwner: false,
      };
      const companySection = await runAsTenantWithPlatformBots(
        { ...manageScope, userId: a.userId },
        () =>
          db.botSection.create({
            data: {
              id: companySectionId,
              spaceId: a.spaceId,
              userId: a.userId,
              name: "Company section",
            },
            select: { id: true },
          }),
      );
      expect(companySection.id).toBe(companySectionId);
      const companyTicket = await runAsTenantWithPlatformBots(
        { ...manageScope, userId: a.userId },
        () =>
          db.ticket.create({
            data: {
              id: companyTicketId,
              spaceId: a.spaceId,
              boardId: companyBoardId,
              number: ticketNumber,
              title: "Company ticket",
              createdByBotId: a.botId,
            },
            select: { id: true },
          }),
      );
      expect(companyTicket.id).toBe(companyTicketId);
      await expect(
        runAsTenantWithPlatformBots(scope, () =>
          db.ticket.create({
            data: {
              spaceId: a.spaceId,
              boardId: companyBoardId,
              number: ticketNumber + 1,
              title: "Ticket references inaccessible bot",
              createdByBotId: privateBotId,
            },
            select: { id: true },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        runAsTenantWithPlatformBots({ ...manageScope, userId: a.userId }, () =>
          db.ticket.create({
            data: {
              spaceId: a.spaceId,
              boardId: companyBoardId,
              number: ticketNumber + 2,
              title: "Ticket references foreign-Space bot",
              createdByBotId: b.botId,
            },
            select: { id: true },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        runAsTenantWithPlatformBots({ ...manageScope, userId: a.userId }, async () => {
          await db.chatGroup.create({
            data: {
              id: crossSpaceGroupId,
              spaceId: a.spaceId,
              userId: a.userId,
              name: "Group with foreign-Space member",
            },
            select: { id: true },
          });
          createdCrossSpaceGroup = true;
          await db.chatGroupMember.create({
            data: { groupId: crossSpaceGroupId, botId: b.botId },
          });
        }),
      ).rejects.toThrow(/row-level security/);
      const companyGroup = await runAsTenantWithPlatformBots(
        { ...manageScope, userId: a.userId },
        () =>
          groupRepos.createGroup(companyActor, {
            name: "Company group",
            botIds: [a.botId, privateBotId],
          }),
      );
      companyGroupId = companyGroup.id;
      expect(companyGroup.members.map(({ botId }) => botId).sort()).toEqual(
        [a.botId, privateBotId].sort(),
      );
      const companyActorB = {
        userId: b.userId,
        spaceId: a.spaceId,
        email: `${b.userId}@rakazo.test`,
        isDeploymentOwner: false,
      };
      await expect(
        runAsTenantWithPlatformBots(
          {
            ...scope,
            editBotIds: [a.botId],
            requiredPermission: "edit",
          },
          () =>
            groupRepos.createGroup(companyActorB, {
              name: "Group with inaccessible bot",
              botIds: [a.botId, privateBotId],
            }),
        ),
      ).rejects.toThrow();

      // Normal first-user onboarding has no company Space. It must retain the
      // ordinary tenant policy and also return the newly inserted bot.
      await system.deploymentSettings.update({
        where: { id: "default" },
        data: { companySpaceId: null },
      });
      const actorB = {
        userId: b.userId,
        spaceId: b.spaceId,
        email: `${b.userId}@rakazo.test`,
        isDeploymentOwner: false,
      };
      await system.bot.create({
        data: {
          id: ordinarySecondBotId,
          spaceId: b.spaceId,
          userId: b.userId,
          name: "Second ordinary bot",
          color: "#000",
        },
      });
      const ordinarySection = await runAsTenant({ spaceId: b.spaceId, userId: b.userId }, () =>
        db.botSection.create({
          data: {
            id: ordinarySectionId,
            spaceId: b.spaceId,
            userId: b.userId,
            name: "Ordinary section",
          },
          select: { id: true },
        }),
      );
      expect(ordinarySection.id).toBe(ordinarySectionId);
      const ordinaryGroup = await runAsTenant({ spaceId: b.spaceId, userId: b.userId }, () =>
        groupRepos.createGroup(actorB, {
          name: "Ordinary group",
          botIds: [b.botId, ordinarySecondBotId],
        }),
      );
      ordinaryGroupId = ordinaryGroup.id;
      expect(ordinaryGroup.members.map(({ botId }) => botId).sort()).toEqual(
        [b.botId, ordinarySecondBotId].sort(),
      );
      const ordinaryRepoBot = await runAsTenant({ spaceId: b.spaceId, userId: b.userId }, () =>
        repos.createBot(actorB, {
          id: `rls-ordinary-repo-created-${suffix}`,
          name: "Ordinary repository bot",
          description: "",
          instructions: "",
          notifyOnFinish: false,
          computerMode: "dedicated",
        }),
      );
      repoCreatedOrdinaryBotId = ordinaryRepoBot.id;
      expect(ordinaryRepoBot.id).toBe(`rls-ordinary-repo-created-${suffix}`);
      await system.deploymentSettings.update({
        where: { id: "default" },
        data: { companySpaceId: a.spaceId },
      });

      const unscoped = await runAsTenant({ spaceId: a.spaceId, userId: b.userId }, () =>
        db.bot.findMany({ where: { id: { in: [a.botId, privateBotId] } }, select: { id: true } }),
      );
      expect(unscoped).toEqual([]);
    } finally {
      await system.chatGroup.deleteMany({
        where: {
          id: {
            in: [
              companyGroupId,
              ordinaryGroupId,
              ...(createdCrossSpaceGroup ? [crossSpaceGroupId] : []),
            ].filter((id): id is string => !!id),
          },
        },
      });
      await system.botSection.deleteMany({
        where: { id: { in: [companySectionId, ordinarySectionId] } },
      });
      await system.ticket.deleteMany({ where: { id: companyTicketId } });
      if (createdCompanyBoard) await system.board.deleteMany({ where: { id: companyBoardId } });
      await system.bot.deleteMany({ where: { id: ordinarySecondBotId } });
      await system.spaceMember.deleteMany({ where: { id: crossSpaceMemberId } });
      if (repoCreatedCompanyBotId)
        await system.bot.deleteMany({ where: { id: repoCreatedCompanyBotId } });
      if (repoCreatedOrdinaryBotId)
        await system.bot.deleteMany({ where: { id: repoCreatedOrdinaryBotId } });
      await system.platformBotGrant.deleteMany({ where: { id: grantId } });
      await system.thread.deleteMany({ where: { id: privateThreadId } });
      await system.bot.deleteMany({ where: { id: privateBotId } });
      await system.bot.deleteMany({ where: { id: createdBotId } });
      await system.computer.deleteMany({ where: { id: privateComputerId } });
      await system.computer.deleteMany({ where: { id: createdComputerId } });
      if (settingsBefore)
        await system.deploymentSettings.update({
          where: { id: "default" },
          data: { companySpaceId: settingsBefore.companySpaceId },
        });
      else await system.deploymentSettings.deleteMany({ where: { id: "default" } });
    }
  });
});
