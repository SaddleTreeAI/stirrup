// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CASE_ROLES, lawBotAccess } from "./cases.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("lawBotAccess under row-level security", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const memberId = `law-access-member-${suffix}`;
  const outsiderId = `law-access-outsider-${suffix}`;
  const organizationId = `law-access-org-${suffix}`;
  const spaceId = `law-access-space-${suffix}`;
  const member: Actor = {
    userId: memberId,
    spaceId,
    email: `${memberId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  const outsider: Actor = {
    userId: outsiderId,
    spaceId,
    email: `${outsiderId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: (() => Promise<void>) | undefined;
  let caseBotId = "";
  let ordinaryBotId = "";

  beforeAll(async () => {
    const db = createDb(runtimeUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await system.user.create({
      data: { id: memberId, name: memberId, email: member.email, emailVerified: false },
    });
    await system.user.create({
      data: { id: outsiderId, name: outsiderId, email: outsider.email, emailVerified: false },
    });
    await system.organization.create({
      data: { id: organizationId, name: "Access Org", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
    const lawCase = await system.lawCase.create({
      data: {
        spaceId,
        slug: "reed",
        name: "Commonwealth v. Reed",
        brief: "Reed brief",
        position: 0,
      },
    });
    await system.lawCaseMember.create({ data: { caseId: lawCase.id, userId: memberId } });
    for (const role of CASE_ROLES) {
      const bot = await system.bot.create({
        data: { spaceId, userId: memberId, name: role.name, color: "blue" },
      });
      await system.lawCaseBot.create({
        data: { caseId: lawCase.id, role: role.role, botId: bot.id },
      });
      if (role.role === "manager") caseBotId = bot.id;
    }
    const ordinary = await system.bot.create({
      data: { spaceId, userId: memberId, name: "General Bot", color: "green" },
    });
    ordinaryBotId = ordinary.id;
  });

  afterAll(async () => {
    if (system) {
      await system.organization.deleteMany({ where: { id: organizationId } });
      await system.user.deleteMany({ where: { id: { in: [memberId, outsiderId] } } });
    }
    await close?.();
  });

  it("allows the case member and denies the non-member on a case bot", async () => {
    await expect(lawBotAccess(prisma, member, caseBotId)).resolves.toBe("allow");
    await expect(lawBotAccess(prisma, outsider, caseBotId)).resolves.toBe("deny");
  });

  it("allows an ordinary bot for both users", async () => {
    await expect(lawBotAccess(prisma, member, ordinaryBotId)).resolves.toBe("allow");
    await expect(lawBotAccess(prisma, outsider, ordinaryBotId)).resolves.toBe("allow");
  });
});
