// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeLawCase } from "./handlers/purge-case.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

function fakeArtifacts(): ArtifactStore & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    describe: () => ({
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { stream: true },
    }),
    put: async () => ({ id: "new", hash: "0" }),
    get: async () => new Uint8Array(),
    stream: async function* () {},
    remove: async (id) => {
      removed.push(id);
    },
  };
}

describePostgres("purgeLawCase against Postgres", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `law-purge-user-${suffix}`;
  const organizationId = `law-purge-org-${suffix}`;
  const spaceId = `law-purge-space-${suffix}`;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: (() => Promise<void>) | undefined;
  let targetCaseId = "";
  let otherCaseId = "";
  let botId = "";

  beforeAll(async () => {
    const db = createDb(runtimeUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await system.user.create({
      data: {
        id: userId,
        name: userId,
        email: `${userId}@rakazo.test`,
        emailVerified: false,
      },
    });
    await system.organization.create({
      data: { id: organizationId, name: "Purge Org", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
    const bot = await system.bot.create({
      data: {
        id: randomUUID(),
        spaceId,
        userId,
        name: "Purge Bot",
        color: "blue",
      },
    });
    botId = bot.id;

    const past = new Date("2020-01-01T00:00:00.000Z");
    const target = await system.lawCase.create({
      data: {
        spaceId,
        slug: `purge-target-${suffix}`,
        name: "Commonwealth v. PurgeTarget",
        brief: "SYNTHETIC brief",
        position: 0,
        deletedAt: past,
        deletedBy: userId,
        purgeAfter: past,
        legalHold: false,
      },
    });
    targetCaseId = target.id;

    const other = await system.lawCase.create({
      data: {
        spaceId,
        slug: `purge-other-${suffix}`,
        name: "Commonwealth v. PurgeOther",
        brief: "SYNTHETIC brief other",
        position: 1,
      },
    });
    otherCaseId = other.id;

    const otherDoc = await system.lawDocument.create({
      data: {
        caseId: otherCaseId,
        title: "Keep me",
        body: "other",
        kind: "library",
        filename: "other.txt",
        artifactId: "other-art",
      },
    });
    await system.lawDocumentPage.create({
      data: { documentId: otherDoc.id, page: 1, text: "keep" },
    });

    const doc = await system.lawDocument.create({
      data: {
        caseId: targetCaseId,
        title: "Target doc",
        body: "target",
        kind: "library",
        filename: "target.pdf",
        artifactId: "target-art",
        derivedArtifactId: "target-derived",
      },
    });
    await system.lawDocumentPage.create({
      data: { documentId: doc.id, page: 1, text: "page" },
    });
    await system.lawTranscriptSegment.create({
      data: {
        documentId: doc.id,
        idx: 0,
        startMs: 0,
        endMs: 1000,
        text: "seg",
      },
    });
    await system.lawMediaFrame.create({
      data: {
        documentId: doc.id,
        tMs: 0,
        artifactId: "target-frame",
        caption: "frame",
      },
    });
    await system.lawJob.create({
      data: {
        caseId: targetCaseId,
        documentId: doc.id,
        kind: "selftest",
        status: "done",
        payload: {},
      },
    });
    await system.lawCaseMember.create({
      data: { caseId: targetCaseId, userId },
    });
    await system.lawCaseBot.create({
      data: { caseId: targetCaseId, role: "manager", botId },
    });
  }, 60_000);

  afterAll(async () => {
    if (!system) return;
    await system.lawCaseBot.deleteMany({ where: { caseId: { in: [targetCaseId, otherCaseId] } } });
    const docs = await system.lawDocument.findMany({
      where: { caseId: { in: [targetCaseId, otherCaseId] } },
      select: { id: true },
    });
    const docIds = docs.map((row) => row.id);
    if (docIds.length > 0) {
      await system.lawMediaFrame.deleteMany({ where: { documentId: { in: docIds } } });
      await system.lawTranscriptSegment.deleteMany({ where: { documentId: { in: docIds } } });
      await system.lawDocumentPage.deleteMany({ where: { documentId: { in: docIds } } });
    }
    await system.lawDocument.deleteMany({
      where: { caseId: { in: [targetCaseId, otherCaseId] } },
    });
    await system.lawJob.deleteMany({ where: { caseId: { in: [targetCaseId, otherCaseId] } } });
    await system.lawCaseMember.deleteMany({
      where: { caseId: { in: [targetCaseId, otherCaseId] } },
    });
    await system.lawCase.deleteMany({ where: { id: { in: [targetCaseId, otherCaseId] } } });
    if (botId) await system.bot.deleteMany({ where: { id: botId } });
    await system.space.deleteMany({ where: { id: spaceId } });
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: userId } });
    await close?.();
  });

  it("removes every child of the target case and leaves others untouched", async () => {
    const artifacts = fakeArtifacts();
    const result = await purgeLawCase(system, {
      caseId: targetCaseId,
      now: new Date("2026-06-01T00:00:00.000Z"),
      artifacts,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dryRun).toBe(false);

    expect(await system.lawCase.findUnique({ where: { id: targetCaseId } })).toBeNull();
    expect(await system.lawDocument.count({ where: { caseId: targetCaseId } })).toBe(0);
    expect(await system.lawJob.count({ where: { caseId: targetCaseId } })).toBe(0);
    expect(await system.lawCaseMember.count({ where: { caseId: targetCaseId } })).toBe(0);
    expect(await system.lawCaseBot.count({ where: { caseId: targetCaseId } })).toBe(0);

    expect(await system.lawCase.findUnique({ where: { id: otherCaseId } })).toBeTruthy();
    expect(await system.lawDocument.count({ where: { caseId: otherCaseId } })).toBe(1);

    const bot = await system.bot.findUnique({ where: { id: botId } });
    expect(bot?.archivedAt).toBeInstanceOf(Date);

    expect(artifacts.removed.sort()).toEqual(["target-art", "target-derived", "target-frame"]);
  });
});
