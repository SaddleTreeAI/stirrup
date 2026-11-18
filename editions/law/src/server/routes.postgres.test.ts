// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, drainUnscopedDatabaseAccess, runAsTenant } from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountLawRoutes } from "./routes.js";

// The API connects as the runtime login. These rows are visible only after the
// route sets the space, the same way a deployment enforces row-level security.
const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("law cases under row-level security", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `law-cases-user-${suffix}`;
  const otherUserId = `law-cases-other-${suffix}`;
  const organizationId = `law-cases-org-${suffix}`;
  const spaceId = `law-cases-space-${suffix}`;
  const otherSpaceId = `law-cases-space-b-${suffix}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  const otherActor: Actor = {
    userId: otherUserId,
    spaceId: otherSpaceId,
    email: `${otherUserId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: (() => Promise<void>) | undefined;
  let app: Hono;
  const caseIds: string[] = [];
  let otherCaseId = "";
  let otherDocId = "";

  beforeAll(async () => {
    const db = createDb(runtimeUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await system.user.create({
      data: { id: userId, name: userId, email: actor.email, emailVerified: false },
    });
    await system.user.create({
      data: {
        id: otherUserId,
        name: otherUserId,
        email: otherActor.email,
        emailVerified: false,
      },
    });
    await system.organization.create({
      data: { id: organizationId, name: "Law Org", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
    await system.space.create({
      data: { id: otherSpaceId, organizationId, name: "Other", isDefault: false },
    });
    const names = ["Ruiz", "Ward", "Nunez"] as const;
    for (const [position, name] of names.entries()) {
      const created = await system.lawCase.create({
        data: {
          spaceId,
          slug: name.toLowerCase(),
          name,
          brief: `${name} brief`,
          position,
        },
      });
      caseIds.push(created.id);
      await system.lawCaseMember.create({ data: { caseId: created.id, userId } });
      const bot = await system.bot.create({
        data: { spaceId, userId, name: "Case Manager", color: "blue" },
      });
      await system.lawCaseBot.create({
        data: { caseId: created.id, role: "manager", botId: bot.id },
      });
      if (position === 0) {
        await system.lawDocument.create({
          data: {
            caseId: created.id,
            title: "Complaint",
            filename: "complaint.pdf",
            body: "SYNTHETIC complaint",
            kind: "library",
            version: 1,
          },
        });
      }
    }
    const otherCase = await system.lawCase.create({
      data: {
        spaceId: otherSpaceId,
        slug: "other",
        name: "Other Case",
        brief: "Other brief",
        position: 0,
      },
    });
    otherCaseId = otherCase.id;
    await system.lawCaseMember.create({
      data: { caseId: otherCase.id, userId: otherUserId },
    });
    const otherDoc = await system.lawDocument.create({
      data: {
        caseId: otherCase.id,
        title: "Secret",
        filename: "secret.txt",
        body: "SYNTHETIC secret from case B",
        kind: "library",
        version: 1,
      },
    });
    otherDocId = otherDoc.id;

    app = new Hono();
    mountLawRoutes(app, {
      prisma,
      sessionActor: async (request) => (request.headers.get("authorization") ? actor : null),
    });
  });

  afterAll(async () => {
    if (system) {
      await system.organization.deleteMany({ where: { id: organizationId } });
      await system.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    }
    await close?.();
  });

  it("returns the three cases for the runtime login once the space is set", async () => {
    const hidden = await prisma.lawCaseMember.count({ where: { userId } });
    expect(hidden).toBe(0);
    expect(drainUnscopedDatabaseAccess().join("\n")).toContain("LawCaseMember.count");

    const denied = await app.request("/api/law/cases");
    expect(denied.status).toBe(401);

    const response = await app.request("/api/law/cases", {
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      cases: Array<{ name: string; bots: Array<{ role: string; name: string; botId: string }> }>;
    };
    expect(body.cases.map((item) => item.name)).toEqual(["Ruiz", "Ward", "Nunez"]);
    expect(body.cases[0]?.bots).toEqual([
      { role: "manager", name: "Case Manager", botId: expect.any(String) },
    ]);

    const documents = await app.request(`/api/law/cases/${caseIds[0]}/documents`, {
      headers: { authorization: "Bearer test" },
    });
    expect(documents.status).toBe(200);
    await expect(documents.json()).resolves.toMatchObject({
      documents: [{ title: "Complaint", kind: "library", filename: "complaint.pdf", version: 1 }],
    });

    const review = await system.lawDocument.create({
      data: {
        caseId: caseIds[0]!,
        title: "Motion draft",
        filename: "motion-draft.md",
        body: "SYNTHETIC DRAFT — NOT FOR FILING\nFirst version",
        kind: "review",
        version: 1,
      },
    });
    const versioned = await app.request(
      `/api/law/cases/${caseIds[0]}/documents/${review.id}/versions`,
      {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({ body: "SYNTHETIC DRAFT — NOT FOR FILING\nSecond version" }),
      },
    );
    expect(versioned.status).toBe(201);
    await expect(versioned.json()).resolves.toMatchObject({
      document: {
        title: "Motion draft",
        filename: "motion-draft.md",
        version: 2,
        body: "SYNTHETIC DRAFT — NOT FOR FILING\nSecond version",
      },
    });

    const bot = await system.bot.create({
      data: { spaceId, userId, name: "Custom", color: "green" },
    });
    const attached = await app.request(`/api/law/cases/${caseIds[0]}/bots`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ botId: bot.id }),
    });
    expect(attached.status).toBe(200);
    await expect(attached.json()).resolves.toMatchObject({
      botId: bot.id,
      role: `custom:${bot.id}`,
    });
  });

  it("hides case B documents from case A's tenant", async () => {
    const visibleToOwner = await runAsTenant(otherActor, () =>
      prisma.lawDocument.findMany({ where: { caseId: otherCaseId } }),
    );
    expect(visibleToOwner.map((doc) => doc.id)).toEqual([otherDocId]);

    const hiddenFromA = await runAsTenant(actor, () =>
      prisma.lawDocument.findMany({ where: { caseId: otherCaseId } }),
    );
    expect(hiddenFromA).toEqual([]);

    const outsiderDocs = await app.request(`/api/law/cases/${otherCaseId}/documents`, {
      headers: { authorization: "Bearer test" },
    });
    expect(outsiderDocs.status).toBe(404);
  });
});
