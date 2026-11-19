// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMediaEngine } from "./engine.js";
import { createPrismaJobStore } from "./job-store.js";
import type { Handler } from "./types.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("media engine against Postgres law_jobs", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `law-media-user-${suffix}`;
  const organizationId = `law-media-org-${suffix}`;
  const spaceId = `law-media-space-${suffix}`;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: (() => Promise<void>) | undefined;
  let caseId = "";
  const documentIds: string[] = [];

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
      data: { id: organizationId, name: "Media Org", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
    const created = await system.lawCase.create({
      data: {
        spaceId,
        slug: `media-${suffix}`,
        name: "Commonwealth v. Media",
        brief: "SYNTHETIC brief",
        position: 0,
      },
    });
    caseId = created.id;
    for (let i = 0; i < 20; i += 1) {
      const doc = await system.lawDocument.create({
        data: {
          caseId,
          title: `Doc ${i}`,
          body: "",
          kind: "library",
          filename: `doc-${i}.bin`,
        },
      });
      documentIds.push(doc.id);
      await system.lawJob.create({
        data: {
          caseId,
          documentId: doc.id,
          kind: "selftest",
          status: "queued",
          payload: {},
          runAfter: new Date(Date.now() - 1_000),
        },
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (system && caseId) {
      await system.lawJob.deleteMany({ where: { caseId } });
      await system.lawDocument.deleteMany({ where: { caseId } });
      await system.lawCase.deleteMany({ where: { id: caseId } });
      await system.space.deleteMany({ where: { id: spaceId } });
      await system.organization.deleteMany({ where: { id: organizationId } });
      await system.user.deleteMany({ where: { id: userId } });
    }
    await close?.();
  });

  it("runs each of 20 jobs exactly once across two engines", async () => {
    const seen = new Map<string, number>();
    const handler: Handler = async (ctx) => {
      seen.set(ctx.job.id, (seen.get(ctx.job.id) ?? 0) + 1);
    };
    const store = createPrismaJobStore(system);
    const make = (label: string) =>
      createMediaEngine({
        store,
        prisma: system,
        runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
        handlers: { selftest: handler },
        workerId: `pg-${label}-${randomUUID()}`,
        concurrency: 2,
        idleMs: 20,
        createHandlerIo: () => ({
          readOriginal: async () => {
            throw new Error("unused");
          },
          saveArtifact: async () => ({ id: "unused" }),
        }),
        log: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      });

    const a = make("a");
    const b = make("b");
    const drain = async (engine: ReturnType<typeof createMediaEngine>) => {
      for (let i = 0; i < 60; i += 1) {
        const remaining = await system.lawJob.count({
          where: { caseId, status: { in: ["queued", "running"] } },
        });
        if (remaining === 0) break;
        await engine.tick();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await engine.stop("finish");
    };
    await Promise.all([drain(a), drain(b)]);

    const jobs = await system.lawJob.findMany({ where: { caseId } });
    expect(jobs).toHaveLength(20);
    expect(jobs.every((job) => job.status === "done")).toBe(true);
    expect(seen.size).toBe(20);
    expect([...seen.values()].every((count) => count === 1)).toBe(true);
  }, 120_000);
});
