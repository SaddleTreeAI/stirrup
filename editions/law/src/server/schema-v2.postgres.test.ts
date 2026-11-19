// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const lawPrismaPath = join(dirname(fileURLToPath(import.meta.url)), "../../db/law.prisma");

describe("law schema v2 models in law.prisma", () => {
  it("declares every model the later library / media / case-delete tasks need", () => {
    const source = readFileSync(lawPrismaPath, "utf8");
    for (const name of [
      "LawCase",
      "LawCaseMember",
      "LawDocument",
      "LawDocumentPage",
      "LawTranscriptSegment",
      "LawMediaFrame",
      "LawJob",
      "LawCaseBot",
    ]) {
      expect(source, `missing model ${name}`).toMatch(new RegExp(`^model ${name}\\b`, "m"));
    }
    for (const field of [
      "deletedAt",
      "deletedBy",
      "purgeAfter",
      "createdBy",
      "legalHold",
      "source",
      "mimeType",
      "sizeBytes",
      "sha256",
      "artifactId",
      "derivedArtifactId",
      "speakerNames",
      "status",
      "statusDetail",
      "pageCount",
      "durationMs",
      "uploadedBy",
      "updatedAt",
    ]) {
      expect(source, `missing field ${field}`).toContain(field);
    }
  });
});

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("law schema v2 under Postgres", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `law-schema-user-${suffix}`;
  const organizationId = `law-schema-org-${suffix}`;
  const spaceId = `law-schema-space-${suffix}`;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: (() => Promise<void>) | undefined;
  let caseId = "";
  let documentId = "";

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
      data: { id: organizationId, name: "Schema Org", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
    const created = await system.lawCase.create({
      data: {
        spaceId,
        slug: "schema",
        name: "Commonwealth v. Schema",
        brief: "SYNTHETIC brief",
        position: 0,
      },
    });
    caseId = created.id;
    await system.lawCaseMember.create({ data: { caseId, userId } });
  });

  afterAll(async () => {
    if (system) {
      await system.organization.deleteMany({ where: { id: organizationId } });
      await system.user.deleteMany({ where: { id: userId } });
    }
    await close?.();
  });

  it("applies document defaults and stores page, segment, frame, and job rows", async () => {
    const doc = await system.lawDocument.create({
      data: {
        caseId,
        title: "Hand note",
        filename: "note.txt",
        body: "SYNTHETIC body",
        kind: "library",
      },
    });
    documentId = doc.id;
    expect(doc.status).toBe("ready");
    // Column default is "bot"; a hand-inserted row with no sourceRunId is "edit"
    // after the same UPDATE the migration runs for existing bodies.
    expect(doc.source).toBe("bot");
    expect(doc.mimeType).toBe("");
    expect(doc.sizeBytes).toBe(0);
    expect(doc.speakerNames).toEqual({});

    await system.$executeRaw`
      UPDATE "law_documents"
      SET
        "source" = CASE WHEN "sourceRunId" IS NOT NULL THEN 'bot' ELSE 'edit' END,
        "sizeBytes" = octet_length("body"),
        "mimeType" = 'text/plain'
      WHERE "id" = ${documentId} AND "mimeType" = ''
    `;
    const afterBackfill = await system.lawDocument.findUniqueOrThrow({ where: { id: documentId } });
    expect(afterBackfill.source).toBe("edit");
    expect(afterBackfill.mimeType).toBe("text/plain");
    expect(afterBackfill.sizeBytes).toBe(Buffer.byteLength("SYNTHETIC body"));

    const page = await system.lawDocumentPage.create({
      data: {
        id: randomUUID(),
        documentId,
        page: 1,
        text: "SYNTHETIC page",
      },
    });
    expect(page.ocr).toBe(false);

    const segment = await system.lawTranscriptSegment.create({
      data: {
        id: randomUUID(),
        documentId,
        idx: 0,
        startMs: 0,
        endMs: 1000,
        text: "SYNTHETIC segment",
      },
    });
    expect(segment.speaker).toBeNull();

    const frame = await system.lawMediaFrame.create({
      data: {
        id: randomUUID(),
        documentId,
        tMs: 0,
      },
    });
    expect(frame.caption).toBe("");

    const job = await system.lawJob.create({
      data: {
        id: randomUUID(),
        caseId,
        documentId,
        kind: "extract_pdf",
      },
    });
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBe(3);
    expect(job.payload).toEqual({});
  });

  it("rejects duplicate page and segment idx for the same document", async () => {
    await expect(
      system.lawDocumentPage.create({
        data: {
          id: randomUUID(),
          documentId,
          page: 1,
          text: "duplicate",
        },
      }),
    ).rejects.toThrow();
    await expect(
      system.lawTranscriptSegment.create({
        data: {
          id: randomUUID(),
          documentId,
          idx: 0,
          startMs: 10,
          endMs: 20,
          text: "duplicate",
        },
      }),
    ).rejects.toThrow();
  });

  it("cascades document delete to pages, segments, and frames", async () => {
    await system.lawDocument.delete({ where: { id: documentId } });
    expect(await system.lawDocumentPage.count({ where: { documentId } })).toBe(0);
    expect(await system.lawTranscriptSegment.count({ where: { documentId } })).toBe(0);
    expect(await system.lawMediaFrame.count({ where: { documentId } })).toBe(0);
    const jobs = await system.lawJob.findMany({ where: { caseId } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.documentId).toBeNull();
  });
});
