// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

/**
 * Permanently remove a soft-deleted case after its retention window.
 *
 * Bot lifecycle: archive via Prisma + cancelRunsInTransaction (system actor).
 * Full destroyBot needs sandbox/home/jobs the media sidecar does not wire;
 * archived bot rows and their threads remain hidden. A future core repo
 * method (e.g. archiveBotsByIds) could own the full adapter teardown.
 */
import type { ArtifactStore } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  cancelRunsInTransaction,
  expireComputerExecutionLeases,
  installAuditEventStore,
  tryRecordAuditEvent,
} from "@rakazo/db";
import { lawCaseRetentionDays } from "../../constants.js";
import { createMediaArtifactStore } from "../store.js";
import type { Handler, HandlerContext, MediaLog } from "../types.js";

export const PURGE_CASE_KIND = "purge_case";
export const ARTIFACT_BATCH = 50;
export const DEFAULT_PURGE_SWEEP_MINUTES = 60;

export type PurgeCaseCounts = {
  artifacts: number;
  frames: number;
  segments: number;
  pages: number;
  documents: number;
  jobs: number;
  members: number;
  caseBots: number;
  botsArchived: number;
};

export type PurgeCaseResult =
  | { ok: true; dryRun: boolean; counts: PurgeCaseCounts }
  | {
      ok: false;
      reason: "not_found" | "not_deleted" | "legal_hold" | "retention" | "already_gone";
    };

export type PurgeCaseOptions = {
  caseId: string;
  dryRun?: boolean;
  /** CLI only: purge before purgeAfter (still requires deletedAt and no hold). */
  forceBeforeRetention?: boolean;
  now?: Date;
  /** Injected store (tests). Default: createMediaArtifactStore(prisma). */
  artifacts?: ArtifactStore;
  log?: MediaLog;
};

export function purgeSweepMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.LAW_PURGE_SWEEP_MINUTES ?? DEFAULT_PURGE_SWEEP_MINUTES);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_PURGE_SWEEP_MINUTES;
  return Math.floor(raw);
}

/** Whether the sweeper should run (retention 0 disables auto-purge entirely). */
export function purgeSweepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return lawCaseRetentionDays(env) > 0;
}

export function emptyPurgeCounts(): PurgeCaseCounts {
  return {
    artifacts: 0,
    frames: 0,
    segments: 0,
    pages: 0,
    documents: 0,
    jobs: 0,
    members: 0,
    caseBots: 0,
    botsArchived: 0,
  };
}

type EligibleCase = {
  id: string;
  spaceId: string;
  deletedAt: Date | null;
  purgeAfter: Date | null;
  legalHold: boolean;
};

export function isEligibleForPurge(
  row: EligibleCase,
  now: Date,
  forceBeforeRetention: boolean,
): PurgeCaseResult | { ok: true } {
  if (row.legalHold) return { ok: false, reason: "legal_hold" };
  if (!row.deletedAt) return { ok: false, reason: "not_deleted" };
  if (!forceBeforeRetention) {
    if (!row.purgeAfter || row.purgeAfter.getTime() > now.getTime()) {
      return { ok: false, reason: "retention" };
    }
  }
  return { ok: true };
}

/** Enqueue purge_case for one case (idempotent while queued or running). */
export async function enqueuePurgeCase(
  prisma: PrismaClient,
  input: { caseId: string; forceBeforeRetention?: boolean; runAfter?: Date },
): Promise<{ id: string; created: boolean }> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.lawJob.findFirst({
      where: {
        caseId: input.caseId,
        kind: PURGE_CASE_KIND,
        status: { in: ["queued", "running"] },
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    if (existing) return { id: existing.id, created: false };

    const created = await tx.lawJob.create({
      data: {
        caseId: input.caseId,
        documentId: null,
        kind: PURGE_CASE_KIND,
        status: "queued",
        payload: {
          forceBeforeRetention: input.forceBeforeRetention === true,
        },
        maxAttempts: 5,
        runAfter: input.runAfter ?? new Date(),
      },
      select: { id: true },
    });
    return { id: created.id, created: true };
  });
}

/**
 * Find soft-deleted cases past purgeAfter and enqueue purge_case jobs.
 * Returns how many new jobs were created (counts only; no names).
 */
export async function sweepPurgeCases(
  prisma: PrismaClient,
  options: { now?: Date; log?: MediaLog } = {},
): Promise<{ enqueued: number; scanned: number }> {
  if (!purgeSweepEnabled()) return { enqueued: 0, scanned: 0 };
  const now = options.now ?? new Date();
  const due = await prisma.lawCase.findMany({
    where: {
      deletedAt: { not: null },
      legalHold: false,
      purgeAfter: { lt: now },
    },
    select: { id: true },
    take: 100,
  });
  let enqueued = 0;
  for (const row of due) {
    const result = await enqueuePurgeCase(prisma, { caseId: row.id });
    if (result.created) enqueued += 1;
  }
  options.log?.info("purge sweep", { scanned: due.length, enqueued });
  return { enqueued, scanned: due.length };
}

async function loadCase(prisma: PrismaClient, caseId: string): Promise<EligibleCase | null> {
  return prisma.lawCase.findUnique({
    where: { id: caseId },
    select: {
      id: true,
      spaceId: true,
      deletedAt: true,
      purgeAfter: true,
      legalHold: true,
    },
  });
}

async function collectArtifactTargets(
  prisma: PrismaClient,
  caseId: string,
  limit: number,
): Promise<Array<{ kind: "document" | "derived" | "frame"; rowId: string; artifactId: string }>> {
  const out: Array<{
    kind: "document" | "derived" | "frame";
    rowId: string;
    artifactId: string;
  }> = [];
  const docs = await prisma.lawDocument.findMany({
    where: {
      caseId,
      OR: [{ artifactId: { not: null } }, { derivedArtifactId: { not: null } }],
    },
    select: { id: true, artifactId: true, derivedArtifactId: true },
    take: limit,
  });
  for (const doc of docs) {
    if (doc.artifactId) {
      out.push({ kind: "document", rowId: doc.id, artifactId: doc.artifactId });
      if (out.length >= limit) return out;
    }
    if (doc.derivedArtifactId) {
      out.push({ kind: "derived", rowId: doc.id, artifactId: doc.derivedArtifactId });
      if (out.length >= limit) return out;
    }
  }
  const docIds = (
    await prisma.lawDocument.findMany({
      where: { caseId },
      select: { id: true },
    })
  ).map((row) => row.id);
  if (docIds.length === 0) return out;
  const remaining = limit - out.length;
  if (remaining <= 0) return out;
  const frames = await prisma.lawMediaFrame.findMany({
    where: { documentId: { in: docIds }, artifactId: { not: null } },
    select: { id: true, artifactId: true },
    take: remaining,
  });
  for (const frame of frames) {
    if (!frame.artifactId) continue;
    out.push({ kind: "frame", rowId: frame.id, artifactId: frame.artifactId });
  }
  return out;
}

async function deleteArtifactsBatch(
  prisma: PrismaClient,
  artifacts: ArtifactStore,
  spaceId: string,
  caseId: string,
  counts: PurgeCaseCounts,
): Promise<boolean> {
  const batch = await collectArtifactTargets(prisma, caseId, ARTIFACT_BATCH);
  if (batch.length === 0) return false;
  for (const target of batch) {
    const context = createAdapterContext(
      { spaceId, userId: "media-sidecar" },
      "media",
      `purge-${target.artifactId}`,
    );
    // FKs store the artifact row id; disk/object keys are storageKey.
    const row = await prisma.artifact.findFirst({
      where: { id: target.artifactId, spaceId },
      select: { storageKey: true },
    });
    if (row) await artifacts.remove(row.storageKey, context);
    counts.artifacts += 1;
    if (target.kind === "document") {
      await prisma.lawDocument.update({
        where: { id: target.rowId },
        data: { artifactId: null },
      });
    } else if (target.kind === "derived") {
      await prisma.lawDocument.update({
        where: { id: target.rowId },
        data: { derivedArtifactId: null },
      });
    } else {
      await prisma.lawMediaFrame.update({
        where: { id: target.rowId },
        data: { artifactId: null },
      });
    }
  }
  return true;
}

/**
 * Archive case bots without adapter sandbox/home: cancel active runs, pause
 * routines, expire execution leases, set archivedAt. Threads remain.
 */
export async function archiveCaseBots(
  prisma: PrismaClient,
  botIds: string[],
  now = new Date(),
): Promise<number> {
  let archived = 0;
  for (const botId of botIds) {
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      select: {
        id: true,
        spaceId: true,
        userId: true,
        archivedAt: true,
      },
    });
    if (!bot) continue;
    if (bot.archivedAt) {
      archived += 1;
      continue;
    }
    const activeRuns = await prisma.run.findMany({
      where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true, taskId: true, userId: true, spaceId: true },
    });
    await prisma.$transaction(async (tx) => {
      await cancelRunsInTransaction(tx, activeRuns, now);
      await tx.routine.updateMany({
        where: { botId: bot.id },
        data: { active: false, nextRunAt: null },
      });
      await expireComputerExecutionLeases(tx, { botId: bot.id });
      await tx.bot.update({
        where: { id: bot.id },
        data: { archivedAt: now, pinned: false },
      });
    });
    archived += 1;
  }
  return archived;
}

async function countChildren(prisma: PrismaClient, caseId: string): Promise<PurgeCaseCounts> {
  const docs = await prisma.lawDocument.findMany({
    where: { caseId },
    select: { id: true, artifactId: true, derivedArtifactId: true },
  });
  const docIds = docs.map((row) => row.id);
  const artifactRefs =
    docs.filter((row) => row.artifactId).length +
    docs.filter((row) => row.derivedArtifactId).length +
    (docIds.length === 0
      ? 0
      : await prisma.lawMediaFrame.count({
          where: { documentId: { in: docIds }, artifactId: { not: null } },
        }));
  const [frames, segments, pages, jobs, members, caseBots] = await Promise.all([
    docIds.length === 0
      ? Promise.resolve(0)
      : prisma.lawMediaFrame.count({ where: { documentId: { in: docIds } } }),
    docIds.length === 0
      ? Promise.resolve(0)
      : prisma.lawTranscriptSegment.count({ where: { documentId: { in: docIds } } }),
    docIds.length === 0
      ? Promise.resolve(0)
      : prisma.lawDocumentPage.count({ where: { documentId: { in: docIds } } }),
    prisma.lawJob.count({ where: { caseId } }),
    prisma.lawCaseMember.count({ where: { caseId } }),
    prisma.lawCaseBot.count({ where: { caseId } }),
  ]);
  return {
    artifacts: artifactRefs,
    frames,
    segments,
    pages,
    documents: docs.length,
    jobs,
    members,
    caseBots,
    botsArchived: caseBots,
  };
}

/** Permanently purge a soft-deleted case. Idempotent; case row deleted last. */
export async function purgeLawCase(
  prisma: PrismaClient,
  options: PurgeCaseOptions,
): Promise<PurgeCaseResult> {
  const now = options.now ?? new Date();
  const force = options.forceBeforeRetention === true;
  const dryRun = options.dryRun === true;

  const row = await loadCase(prisma, options.caseId);
  if (!row) return { ok: false, reason: "already_gone" };

  const eligibility = isEligibleForPurge(row, now, force);
  if (!eligibility.ok) return eligibility;

  if (dryRun) {
    const counts = await countChildren(prisma, options.caseId);
    options.log?.info("purge dry-run", {
      caseId: options.caseId,
      ...counts,
    });
    return { ok: true, dryRun: true, counts };
  }

  const artifacts = options.artifacts ?? createMediaArtifactStore(prisma);
  const counts = emptyPurgeCounts();

  // 1. Artifacts in batches of 50 (re-check eligibility each batch).
  for (;;) {
    const current = await loadCase(prisma, options.caseId);
    if (!current) return { ok: false, reason: "already_gone" };
    const again = isEligibleForPurge(current, now, force);
    if (!again.ok) return again;
    const more = await deleteArtifactsBatch(
      prisma,
      artifacts,
      current.spaceId,
      options.caseId,
      counts,
    );
    if (!more) break;
  }

  const caseBots = await prisma.lawCaseBot.findMany({
    where: { caseId: options.caseId },
    select: { botId: true },
  });
  const botIds = caseBots.map((entry) => entry.botId);

  const docIds = (
    await prisma.lawDocument.findMany({
      where: { caseId: options.caseId },
      select: { id: true },
    })
  ).map((entry) => entry.id);

  if (docIds.length > 0) {
    const frames = await prisma.lawMediaFrame.deleteMany({
      where: { documentId: { in: docIds } },
    });
    counts.frames += frames.count;
    const segments = await prisma.lawTranscriptSegment.deleteMany({
      where: { documentId: { in: docIds } },
    });
    counts.segments += segments.count;
    const pages = await prisma.lawDocumentPage.deleteMany({
      where: { documentId: { in: docIds } },
    });
    counts.pages += pages.count;
  }

  const documents = await prisma.lawDocument.deleteMany({ where: { caseId: options.caseId } });
  counts.documents += documents.count;

  // Includes this running purge job; the engine markDone then updates 0 rows.
  const jobs = await prisma.lawJob.deleteMany({ where: { caseId: options.caseId } });
  counts.jobs += jobs.count;

  const members = await prisma.lawCaseMember.deleteMany({ where: { caseId: options.caseId } });
  counts.members += members.count;

  const mapping = await prisma.lawCaseBot.deleteMany({ where: { caseId: options.caseId } });
  counts.caseBots += mapping.count;

  counts.botsArchived = await archiveCaseBots(prisma, botIds, now);

  const spaceId = row.spaceId;
  installAuditEventStore(prisma);
  await tryRecordAuditEvent({
    action: "law.case.purged",
    actor: { type: "system", label: "law-purge" },
    spaceId,
    target: { type: "case", id: options.caseId },
    metadata: {
      caseId: options.caseId,
      artifacts: counts.artifacts,
      frames: counts.frames,
      segments: counts.segments,
      pages: counts.pages,
      documents: counts.documents,
      jobs: counts.jobs,
      members: counts.members,
      caseBots: counts.caseBots,
      botsArchived: counts.botsArchived,
    },
  });

  // Case row last.
  await prisma.lawCase.delete({ where: { id: options.caseId } });

  options.log?.info("purge complete", { caseId: options.caseId, ...counts });
  return { ok: true, dryRun: false, counts };
}

function forceFromPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as { forceBeforeRetention?: unknown }).forceBeforeRetention === true;
}

/** Job handler: purge_case. */
export const purgeCaseHandler: Handler = async (ctx: HandlerContext) => {
  const result = await purgeLawCase(ctx.prisma, {
    caseId: ctx.job.caseId,
    forceBeforeRetention: forceFromPayload(ctx.job.payload),
    log: ctx.log,
  });
  if (!result.ok) {
    if (result.reason === "already_gone") return;
    throw new Error(`purge refused: ${result.reason}`);
  }
};
