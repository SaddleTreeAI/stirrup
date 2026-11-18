// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LAW_SEED_EMAIL, seedLawPlatform } from "./seed.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("law platform seed", () => {
  const loginDir = mkdtempSync(path.join(tmpdir(), "law-seed-"));
  const loginFile = path.join(loginDir, "login.txt");
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: (() => Promise<void>) | undefined;
  let spaceId = "";
  let ruizCaseId = "";

  beforeAll(async () => {
    const first = await seedLawPlatform({
      loginFile,
      databaseUrl: migrationUrl!,
      quiet: true,
    });
    spaceId = first.spaceId;
    const second = await seedLawPlatform({
      loginFile,
      databaseUrl: migrationUrl!,
      quiet: true,
    });
    expect(second.spaceId).toBe(first.spaceId);
    expect(second.userId).toBe(first.userId);
    expect(second.cases).toEqual(first.cases);

    const db = createDb(runtimeUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };

    const cases = await system.lawCase.findMany({
      where: { spaceId },
      select: { id: true, slug: true },
      orderBy: { position: "asc" },
    });
    expect(cases.map((row) => row.slug)).toEqual(["ruiz", "ward", "nunez"]);
    ruizCaseId = cases.find((row) => row.slug === "ruiz")!.id;
    const bots = await system.lawCaseBot.count({
      where: { caseId: { in: cases.map((row) => row.id) } },
    });
    expect(bots).toBe(12);
    const login = readFileSync(loginFile, "utf8");
    expect(login).toContain(`email=${LAW_SEED_EMAIL}`);
    expect(login).toMatch(/^password=.+/m);
  });

  afterAll(async () => {
    rmSync(loginDir, { recursive: true, force: true });
    await close?.();
  });

  it("hides Ruiz documents from a Ward-only tenant space", async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const wardUserId = `ward-user-${suffix}`;
    const wardOrgId = `ward-org-${suffix}`;
    const wardSpaceId = `ward-space-${suffix}`;
    await system.user.create({
      data: {
        id: wardUserId,
        name: "Ward Only",
        email: `${wardUserId}@demonstration-defense.example`,
        emailVerified: false,
      },
    });
    await system.organization.create({
      data: {
        id: wardOrgId,
        name: "Ward Tenant",
        slug: wardOrgId,
        createdAt: new Date(),
      },
    });
    await system.space.create({
      data: {
        id: wardSpaceId,
        organizationId: wardOrgId,
        name: "Ward Space",
        isDefault: true,
      },
    });

    const ruizDocsAsOwner = await runAsTenant(
      {
        userId: (await system.user.findUniqueOrThrow({ where: { email: LAW_SEED_EMAIL } })).id,
        spaceId,
      },
      () => prisma.lawDocument.findMany({ where: { caseId: ruizCaseId } }),
    );
    expect(ruizDocsAsOwner.length).toBeGreaterThan(0);

    const ruizDocsAsWard = await runAsTenant({ userId: wardUserId, spaceId: wardSpaceId }, () =>
      prisma.lawDocument.findMany({ where: { caseId: ruizCaseId } }),
    );
    expect(ruizDocsAsWard).toEqual([]);

    await system.organization.deleteMany({ where: { id: wardOrgId } });
    await system.user.deleteMany({ where: { id: wardUserId } });
  });
});
