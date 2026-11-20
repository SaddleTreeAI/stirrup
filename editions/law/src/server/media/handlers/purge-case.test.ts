// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { ArtifactStore } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_BATCH,
  archiveCaseBots,
  emptyPurgeCounts,
  enqueuePurgeCase,
  isEligibleForPurge,
  PURGE_CASE_KIND,
  purgeCaseHandler,
  purgeLawCase,
  sweepPurgeCases,
} from "./purge-case.js";

type Doc = {
  id: string;
  caseId: string;
  artifactId: string | null;
  derivedArtifactId: string | null;
};
type Frame = { id: string; documentId: string; artifactId: string | null };
type Segment = { id: string; documentId: string };
type Page = { id: string; documentId: string };
type Job = {
  id: string;
  caseId: string;
  kind: string;
  status: string;
  documentId: string | null;
  payload: unknown;
  createdAt: Date;
};
type Member = { caseId: string; userId: string };
type CaseBot = { caseId: string; role: string; botId: string };
type Bot = {
  id: string;
  spaceId: string;
  userId: string;
  archivedAt: Date | null;
  pinned: boolean;
};
type CaseRow = {
  id: string;
  spaceId: string;
  deletedAt: Date | null;
  purgeAfter: Date | null;
  legalHold: boolean;
};

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

function createFakePrisma(seed: {
  cases?: CaseRow[];
  documents?: Doc[];
  frames?: Frame[];
  segments?: Segment[];
  pages?: Page[];
  jobs?: Job[];
  members?: Member[];
  caseBots?: CaseBot[];
  bots?: Bot[];
}) {
  const state = {
    cases: [...(seed.cases ?? [])],
    documents: [...(seed.documents ?? [])],
    frames: [...(seed.frames ?? [])],
    segments: [...(seed.segments ?? [])],
    pages: [...(seed.pages ?? [])],
    jobs: [...(seed.jobs ?? [])],
    members: [...(seed.members ?? [])],
    caseBots: [...(seed.caseBots ?? [])],
    bots: [...(seed.bots ?? [])],
    audits: [] as Array<{ action: string; metadata: Record<string, unknown> }>,
    failStep: null as null | "after-artifacts" | "after-frames" | "after-docs" | "after-bots",
  };

  const prisma = {
    __state: state,
    lawCase: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.cases.find((row) => row.id === where.id) ?? null,
      findMany: async ({
        where,
        take,
      }: {
        where: {
          deletedAt?: { not: null };
          legalHold?: boolean;
          purgeAfter?: { lt: Date };
        };
        take?: number;
      }) => {
        let rows = state.cases.filter((row) => {
          if (where.deletedAt && !row.deletedAt) return false;
          if (where.legalHold === false && row.legalHold) return false;
          if (where.purgeAfter?.lt && (!row.purgeAfter || row.purgeAfter >= where.purgeAfter.lt)) {
            return false;
          }
          return true;
        });
        if (take !== undefined) rows = rows.slice(0, take);
        return rows.map((row) => ({ id: row.id }));
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const idx = state.cases.findIndex((row) => row.id === where.id);
        if (idx < 0) throw new Error("missing");
        const [removed] = state.cases.splice(idx, 1);
        return removed;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<CaseRow> }) => {
        const row = state.cases.find((entry) => entry.id === where.id);
        if (!row) throw new Error("missing");
        Object.assign(row, data);
        return { ...row };
      },
    },
    lawDocument: {
      findMany: async ({
        where,
        take,
      }: {
        where: {
          caseId: string;
          OR?: Array<Record<string, unknown>>;
        };
        take?: number;
      }) => {
        let rows = state.documents.filter((row) => row.caseId === where.caseId);
        if (where.OR) {
          rows = rows.filter((row) => row.artifactId !== null || row.derivedArtifactId !== null);
        }
        if (take !== undefined) rows = rows.slice(0, take);
        return rows.map((row) => ({ ...row }));
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Doc> }) => {
        const row = state.documents.find((entry) => entry.id === where.id);
        if (!row) throw new Error("missing");
        Object.assign(row, data);
        return row;
      },
      deleteMany: async ({ where }: { where: { caseId: string } }) => {
        if (state.failStep === "after-frames") throw new Error("documents failed");
        const before = state.documents.length;
        state.documents = state.documents.filter((row) => row.caseId !== where.caseId);
        return { count: before - state.documents.length };
      },
      count: async ({ where }: { where: { caseId: string } }) =>
        state.documents.filter((row) => row.caseId === where.caseId).length,
    },
    lawMediaFrame: {
      findMany: async ({
        where,
        take,
      }: {
        where: { documentId: { in: string[] }; artifactId?: { not: null } };
        take?: number;
      }) => {
        let rows = state.frames.filter((row) => where.documentId.in.includes(row.documentId));
        if (where.artifactId) rows = rows.filter((row) => row.artifactId !== null);
        if (take !== undefined) rows = rows.slice(0, take);
        return rows.map((row) => ({ ...row }));
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Frame> }) => {
        const row = state.frames.find((entry) => entry.id === where.id);
        if (!row) throw new Error("missing");
        Object.assign(row, data);
        return row;
      },
      deleteMany: async ({ where }: { where: { documentId: { in: string[] } } }) => {
        if (state.failStep === "after-artifacts") throw new Error("frames failed");
        const before = state.frames.length;
        state.frames = state.frames.filter((row) => !where.documentId.in.includes(row.documentId));
        return { count: before - state.frames.length };
      },
      count: async ({
        where,
      }: {
        where: { documentId: { in: string[] }; artifactId?: { not: null } };
      }) => {
        let rows = state.frames.filter((row) => where.documentId.in.includes(row.documentId));
        if (where.artifactId) rows = rows.filter((row) => row.artifactId !== null);
        return rows.length;
      },
    },
    lawTranscriptSegment: {
      deleteMany: async ({ where }: { where: { documentId: { in: string[] } } }) => {
        const before = state.segments.length;
        state.segments = state.segments.filter(
          (row) => !where.documentId.in.includes(row.documentId),
        );
        return { count: before - state.segments.length };
      },
      count: async ({ where }: { where: { documentId: { in: string[] } } }) =>
        state.segments.filter((row) => where.documentId.in.includes(row.documentId)).length,
    },
    lawDocumentPage: {
      deleteMany: async ({ where }: { where: { documentId: { in: string[] } } }) => {
        const before = state.pages.length;
        state.pages = state.pages.filter((row) => !where.documentId.in.includes(row.documentId));
        return { count: before - state.pages.length };
      },
      count: async ({ where }: { where: { documentId: { in: string[] } } }) =>
        state.pages.filter((row) => where.documentId.in.includes(row.documentId)).length,
    },
    lawJob: {
      findFirst: async ({
        where,
      }: {
        where: { caseId: string; kind: string; status: { in: string[] } };
      }) => {
        const row = state.jobs.find(
          (job) =>
            job.caseId === where.caseId &&
            job.kind === where.kind &&
            where.status.in.includes(job.status),
        );
        return row ? { id: row.id } : null;
      },
      create: async ({
        data,
      }: {
        data: {
          caseId: string;
          documentId: string | null;
          kind: string;
          status: string;
          payload: unknown;
          maxAttempts: number;
          runAfter: Date;
        };
      }) => {
        const row: Job = {
          id: `job-${state.jobs.length + 1}`,
          caseId: data.caseId,
          kind: data.kind,
          status: data.status,
          documentId: data.documentId,
          payload: data.payload,
          createdAt: new Date(),
        };
        state.jobs.push(row);
        return { id: row.id };
      },
      deleteMany: async ({ where }: { where: { caseId: string } }) => {
        if (state.failStep === "after-docs") throw new Error("jobs failed");
        const before = state.jobs.length;
        state.jobs = state.jobs.filter((row) => row.caseId !== where.caseId);
        return { count: before - state.jobs.length };
      },
      count: async ({ where }: { where: { caseId: string } }) =>
        state.jobs.filter((row) => row.caseId === where.caseId).length,
    },
    lawCaseMember: {
      deleteMany: async ({ where }: { where: { caseId: string } }) => {
        const before = state.members.length;
        state.members = state.members.filter((row) => row.caseId !== where.caseId);
        return { count: before - state.members.length };
      },
      count: async ({ where }: { where: { caseId: string } }) =>
        state.members.filter((row) => row.caseId === where.caseId).length,
    },
    lawCaseBot: {
      findMany: async ({ where }: { where: { caseId: string } }) =>
        state.caseBots.filter((row) => row.caseId === where.caseId).map((row) => ({ ...row })),
      deleteMany: async ({ where }: { where: { caseId: string } }) => {
        const before = state.caseBots.length;
        state.caseBots = state.caseBots.filter((row) => row.caseId !== where.caseId);
        return { count: before - state.caseBots.length };
      },
      count: async ({ where }: { where: { caseId: string } }) =>
        state.caseBots.filter((row) => row.caseId === where.caseId).length,
    },
    bot: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.bots.find((row) => row.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<Bot> }) => {
        if (state.failStep === "after-bots") throw new Error("bots failed");
        const row = state.bots.find((entry) => entry.id === where.id);
        if (!row) throw new Error("missing");
        Object.assign(row, data);
        return row;
      },
    },
    run: {
      findMany: async () => [],
    },
    routine: {
      updateMany: async () => ({ count: 0 }),
    },
    computerExecutionLease: {
      updateMany: async () => ({ count: 0 }),
    },
    auditEvent: {
      createMany: async ({ data }: { data: Array<{ action: string; metadata: unknown }> }) => {
        for (const row of data) {
          state.audits.push({
            action: row.action,
            metadata: (row.metadata ?? {}) as Record<string, unknown>,
          });
        }
        return { count: data.length };
      },
    },
    space: {
      findUnique: async () => ({ organizationId: "org-1" }),
      findMany: async () => [{ id: "space-1", organizationId: "org-1" }],
    },
    // Tests seed FKs as opaque ids; treat row id as storageKey unless overridden.
    artifact: {
      findFirst: async ({ where }: { where: { id: string; spaceId: string } }) =>
        where.spaceId ? { id: where.id, storageKey: where.id } : null,
    },
    user: { findUnique: async () => null },
    member: { findMany: async () => [], findFirst: async () => null },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
  };

  return prisma;
}

const past = new Date("2020-01-01T00:00:00.000Z");
const future = new Date("2099-01-01T00:00:00.000Z");
const now = new Date("2026-06-01T00:00:00.000Z");

function seededCase(overrides: Partial<CaseRow> = {}): CaseRow {
  return {
    id: "case-1",
    spaceId: "space-1",
    deletedAt: past,
    purgeAfter: past,
    legalHold: false,
    ...overrides,
  };
}

function fullSeed() {
  return {
    cases: [seededCase()],
    documents: [
      {
        id: "doc-1",
        caseId: "case-1",
        artifactId: "art-1",
        derivedArtifactId: "art-2",
      },
    ],
    frames: [{ id: "frame-1", documentId: "doc-1", artifactId: "art-3" }],
    segments: [{ id: "seg-1", documentId: "doc-1" }],
    pages: [{ id: "page-1", documentId: "doc-1" }],
    jobs: [
      {
        id: "job-1",
        caseId: "case-1",
        kind: PURGE_CASE_KIND,
        status: "running",
        documentId: null,
        payload: {},
        createdAt: past,
      },
    ],
    members: [{ caseId: "case-1", userId: "u1" }],
    caseBots: [{ caseId: "case-1", role: "manager", botId: "bot-1" }],
    bots: [{ id: "bot-1", spaceId: "space-1", userId: "u1", archivedAt: null, pinned: true }],
  };
}

describe("isEligibleForPurge", () => {
  it("requires deletedAt, past purgeAfter, and no legal hold", () => {
    expect(isEligibleForPurge(seededCase(), now, false)).toEqual({ ok: true });
    expect(isEligibleForPurge(seededCase({ legalHold: true }), now, false)).toEqual({
      ok: false,
      reason: "legal_hold",
    });
    expect(isEligibleForPurge(seededCase({ deletedAt: null }), now, false)).toEqual({
      ok: false,
      reason: "not_deleted",
    });
    expect(isEligibleForPurge(seededCase({ purgeAfter: future }), now, false)).toEqual({
      ok: false,
      reason: "retention",
    });
    expect(isEligibleForPurge(seededCase({ purgeAfter: future }), now, true)).toEqual({
      ok: true,
    });
  });
});

describe("purgeLawCase", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks legal hold and incomplete soft-delete", async () => {
    const hold = createFakePrisma({ cases: [seededCase({ legalHold: true })] });
    await expect(purgeLawCase(hold as never, { caseId: "case-1", now })).resolves.toEqual({
      ok: false,
      reason: "legal_hold",
    });

    const open = createFakePrisma({ cases: [seededCase({ deletedAt: null })] });
    await expect(purgeLawCase(open as never, { caseId: "case-1", now })).resolves.toEqual({
      ok: false,
      reason: "not_deleted",
    });
  });

  it("dry-run counts children and deletes nothing", async () => {
    const artifacts = fakeArtifacts();
    const prisma = createFakePrisma(fullSeed());
    const result = await purgeLawCase(prisma as never, {
      caseId: "case-1",
      dryRun: true,
      now,
      artifacts,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dryRun).toBe(true);
    expect(result.counts.artifacts).toBe(3);
    expect(result.counts.documents).toBe(1);
    expect(prisma.__state.cases).toHaveLength(1);
    expect(prisma.__state.documents).toHaveLength(1);
    expect(artifacts.removed).toEqual([]);
  });

  it("removes artifacts once, archives bots, deletes case last", async () => {
    const artifacts = fakeArtifacts();
    const prisma = createFakePrisma(fullSeed());
    const order: string[] = [];

    const originalDelete = prisma.lawCase.delete.bind(prisma.lawCase);
    prisma.lawCase.delete = async (args: { where: { id: string } }) => {
      order.push("case");
      expect(prisma.__state.documents).toHaveLength(0);
      expect(prisma.__state.frames).toHaveLength(0);
      expect(prisma.__state.caseBots).toHaveLength(0);
      expect(prisma.__state.members).toHaveLength(0);
      return originalDelete(args);
    };
    const originalRemove = artifacts.remove.bind(artifacts);
    artifacts.remove = async (id, ctx) => {
      order.push(`artifact:${id}`);
      return originalRemove(id, ctx);
    };

    const result = await purgeLawCase(prisma as never, {
      caseId: "case-1",
      now,
      artifacts,
    });
    expect(result).toMatchObject({ ok: true, dryRun: false });
    expect(artifacts.removed.sort()).toEqual(["art-1", "art-2", "art-3"]);
    expect(new Set(artifacts.removed).size).toBe(3);
    expect(prisma.__state.cases).toHaveLength(0);
    expect(prisma.__state.jobs).toHaveLength(0);
    expect(prisma.__state.bots[0]?.archivedAt).toBeInstanceOf(Date);
    expect(prisma.__state.bots[0]?.pinned).toBe(false);
    expect(order.filter((step) => step.startsWith("artifact:")).length).toBe(3);
    expect(order.at(-1)).toBe("case");
    // Audit metadata is ids and counts only (tryRecordAuditEvent may no-op without org rows).
    for (const audit of prisma.__state.audits) {
      expect(audit.action).toBe("law.case.purged");
      expect(JSON.stringify(audit.metadata)).not.toMatch(/Commonwealth|name|brief|body|text/i);
    }

    await expect(
      purgeLawCase(prisma as never, { caseId: "case-1", now, artifacts }),
    ).resolves.toEqual({ ok: false, reason: "already_gone" });
    expect(artifacts.removed).toHaveLength(3);
  });

  it("resumes after failure at each step without re-deleting artifacts", async () => {
    const steps = ["after-artifacts", "after-frames", "after-docs"] as const;
    for (const failStep of steps) {
      const artifacts = fakeArtifacts();
      const prisma = createFakePrisma(fullSeed());
      prisma.__state.failStep = failStep;
      await expect(
        purgeLawCase(prisma as never, { caseId: "case-1", now, artifacts }),
      ).rejects.toThrow();
      expect(prisma.__state.cases).toHaveLength(1);
      const removedOnce = [...artifacts.removed];

      prisma.__state.failStep = null;
      await purgeLawCase(prisma as never, { caseId: "case-1", now, artifacts });
      expect(prisma.__state.cases).toHaveLength(0);
      // Cleared artifact ids are not removed again on resume.
      expect(artifacts.removed.length).toBe(removedOnce.length);
      expect(new Set(artifacts.removed).size).toBe(artifacts.removed.length);
    }
  });

  it("batches artifact deletes", async () => {
    const artifacts = fakeArtifacts();
    const documents: Doc[] = [];
    for (let i = 0; i < ARTIFACT_BATCH + 3; i += 1) {
      documents.push({
        id: `doc-${i}`,
        caseId: "case-1",
        artifactId: `art-${i}`,
        derivedArtifactId: null,
      });
    }
    const prisma = createFakePrisma({ cases: [seededCase()], documents });
    const batchSizes: number[] = [];
    const originalFind = prisma.lawDocument.findMany.bind(prisma.lawDocument);
    prisma.lawDocument.findMany = async (args: {
      where: { caseId: string; OR?: Array<Record<string, unknown>> };
      take?: number;
    }) => {
      const rows = await originalFind(args);
      if (args.where.OR && rows.length > 0) {
        batchSizes.push(rows.length);
      }
      return rows;
    };
    await purgeLawCase(prisma as never, { caseId: "case-1", now, artifacts });
    expect(batchSizes[0]).toBe(ARTIFACT_BATCH);
    expect(batchSizes[1]).toBe(3);
    expect(artifacts.removed).toHaveLength(ARTIFACT_BATCH + 3);
  });

  it("handler refuses ineligible jobs", async () => {
    const prisma = createFakePrisma({ cases: [seededCase({ legalHold: true })] });
    await expect(
      purgeCaseHandler({
        job: {
          id: "j1",
          caseId: "case-1",
          documentId: null,
          kind: PURGE_CASE_KIND,
          status: "running",
          attempts: 1,
          maxAttempts: 3,
          error: "",
          payload: {},
          runAfter: past,
          lockedAt: past,
          lockedBy: "w",
          createdAt: past,
          updatedAt: past,
          finishedAt: null,
        },
        prisma: prisma as never,
        runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
        tmpDir: "/tmp",
        readOriginal: async () => "",
        saveArtifact: async () => ({ id: "a" }),
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
    ).rejects.toThrow("legal_hold");
  });
});

describe("enqueue and sweep", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("enqueues idempotently and skips when retention is 0", async () => {
    const prisma = createFakePrisma({ cases: [seededCase()] });
    const first = await enqueuePurgeCase(prisma as never, { caseId: "case-1" });
    const second = await enqueuePurgeCase(prisma as never, { caseId: "case-1" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    vi.stubEnv("LAW_CASE_RETENTION_DAYS", "0");
    const swept = await sweepPurgeCases(prisma as never, { now });
    expect(swept).toEqual({ enqueued: 0, scanned: 0 });
  });

  it("sweep enqueues due cases", async () => {
    vi.stubEnv("LAW_CASE_RETENTION_DAYS", "30");
    const prisma = createFakePrisma({
      cases: [
        seededCase({ id: "due" }),
        seededCase({ id: "held", legalHold: true }),
        seededCase({ id: "early", purgeAfter: future }),
      ],
    });
    const swept = await sweepPurgeCases(prisma as never, { now });
    expect(swept.scanned).toBe(1);
    expect(swept.enqueued).toBe(1);
    expect(prisma.__state.jobs[0]?.caseId).toBe("due");
    expect(prisma.__state.jobs[0]?.kind).toBe(PURGE_CASE_KIND);
  });
});

describe("archiveCaseBots", () => {
  it("sets archivedAt and is idempotent", async () => {
    const prisma = createFakePrisma({
      bots: [
        { id: "bot-1", spaceId: "space-1", userId: "u1", archivedAt: null, pinned: true },
        {
          id: "bot-2",
          spaceId: "space-1",
          userId: "u1",
          archivedAt: past,
          pinned: false,
        },
      ],
    });
    const count = await archiveCaseBots(prisma as never, ["bot-1", "bot-2"], now);
    expect(count).toBe(2);
    expect(prisma.__state.bots[0]?.archivedAt).toEqual(now);
    expect(prisma.__state.bots[0]?.pinned).toBe(false);
  });
});

describe("emptyPurgeCounts", () => {
  it("starts at zero", () => {
    expect(emptyPurgeCounts().artifacts).toBe(0);
  });
});
