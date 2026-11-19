// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import type { JobStore, LawJobRow } from "./types.js";

const BACKOFF_SECONDS = 60;

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") return new Date(value);
  return new Date(0);
}

function mapRawJob(row: Record<string, unknown>): LawJobRow {
  return {
    id: String(row.id),
    caseId: String(row.caseId),
    documentId: row.documentId == null ? null : String(row.documentId),
    kind: String(row.kind),
    status: String(row.status),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.maxAttempts),
    error: String(row.error ?? ""),
    payload: row.payload ?? {},
    runAfter: asDate(row.runAfter),
    lockedAt: row.lockedAt == null ? null : asDate(row.lockedAt),
    lockedBy: row.lockedBy == null ? null : String(row.lockedBy),
    createdAt: asDate(row.createdAt),
    updatedAt: asDate(row.updatedAt),
    finishedAt: row.finishedAt == null ? null : asDate(row.finishedAt),
  };
}

/** Postgres-backed store: one UPDATE … SKIP LOCKED claim per call. */
export function createPrismaJobStore(prisma: PrismaClient): JobStore {
  return {
    async requeueStale(staleMinutes) {
      const result = await prisma.$executeRaw`
        UPDATE law_jobs
        SET status = 'queued',
            "lockedAt" = NULL,
            "lockedBy" = NULL,
            "updatedAt" = NOW()
        WHERE status = 'running'
          AND "lockedAt" IS NOT NULL
          AND "lockedAt" < NOW() - (${staleMinutes}::int * INTERVAL '1 minute')
      `;
      return Number(result);
    },

    async claim(workerId) {
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        UPDATE law_jobs
        SET status = 'running',
            "lockedAt" = NOW(),
            "lockedBy" = ${workerId},
            attempts = attempts + 1,
            "updatedAt" = NOW(),
            error = ''
        WHERE id = (
          SELECT id FROM law_jobs
          WHERE status = 'queued' AND "runAfter" <= NOW()
          ORDER BY "runAfter"
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING *
      `;
      const row = rows[0];
      return row ? mapRawJob(row) : null;
    },

    async heartbeat(jobId, workerId) {
      await prisma.$executeRaw`
        UPDATE law_jobs
        SET "lockedAt" = NOW(), "updatedAt" = NOW()
        WHERE id = ${jobId} AND status = 'running' AND "lockedBy" = ${workerId}
      `;
    },

    async markDone(jobId) {
      await prisma.$executeRaw`
        UPDATE law_jobs
        SET status = 'done',
            "lockedAt" = NULL,
            "lockedBy" = NULL,
            "finishedAt" = NOW(),
            "updatedAt" = NOW(),
            error = ''
        WHERE id = ${jobId}
      `;
    },

    async markFailedOrRetry(job, error) {
      const short = error.slice(0, 500);
      if (job.attempts < job.maxAttempts) {
        const delaySeconds = BACKOFF_SECONDS * job.attempts;
        await prisma.$executeRaw`
          UPDATE law_jobs
          SET status = 'queued',
              "lockedAt" = NULL,
              "lockedBy" = NULL,
              error = ${short},
              "runAfter" = NOW() + (${delaySeconds}::int * INTERVAL '1 second'),
              "updatedAt" = NOW()
          WHERE id = ${job.id}
        `;
        return "queued";
      }
      await prisma.$executeRaw`
        UPDATE law_jobs
        SET status = 'failed',
            "lockedAt" = NULL,
            "lockedBy" = NULL,
            error = ${short},
            "finishedAt" = NOW(),
            "updatedAt" = NOW()
        WHERE id = ${job.id}
      `;
      return "failed";
    },

    async releaseToQueued(jobId) {
      await prisma.$executeRaw`
        UPDATE law_jobs
        SET status = 'queued',
            "lockedAt" = NULL,
            "lockedBy" = NULL,
            attempts = GREATEST(attempts - 1, 0),
            "updatedAt" = NOW()
        WHERE id = ${jobId} AND status = 'running'
      `;
    },
  };
}

/** In-memory store for unit tests; simulates SKIP LOCKED with a claim mutex. */
export function createMemoryJobStore(seed: LawJobRow[] = []): JobStore & {
  rows: LawJobRow[];
  insert: (row: Partial<LawJobRow> & Pick<LawJobRow, "caseId" | "kind">) => LawJobRow;
} {
  const rows: LawJobRow[] = [...seed];
  let claimLock: Promise<void> = Promise.resolve();

  const withClaimLock = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = claimLock;
    claimLock = next;
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };

  return {
    rows,
    insert(partial) {
      const now = new Date();
      const row: LawJobRow = {
        id: partial.id ?? randomUUID(),
        caseId: partial.caseId,
        documentId: partial.documentId ?? null,
        kind: partial.kind,
        status: partial.status ?? "queued",
        attempts: partial.attempts ?? 0,
        maxAttempts: partial.maxAttempts ?? 3,
        error: partial.error ?? "",
        payload: partial.payload ?? {},
        runAfter: partial.runAfter ?? now,
        lockedAt: partial.lockedAt ?? null,
        lockedBy: partial.lockedBy ?? null,
        createdAt: partial.createdAt ?? now,
        updatedAt: partial.updatedAt ?? now,
        finishedAt: partial.finishedAt ?? null,
      };
      rows.push(row);
      return row;
    },
    async requeueStale(staleMinutes) {
      const cutoff = Date.now() - staleMinutes * 60_000;
      let count = 0;
      for (const row of rows) {
        if (row.status === "running" && row.lockedAt && row.lockedAt.getTime() < cutoff) {
          row.status = "queued";
          row.lockedAt = null;
          row.lockedBy = null;
          row.updatedAt = new Date();
          count += 1;
        }
      }
      return count;
    },
    async claim(workerId) {
      return withClaimLock(() => {
        const now = Date.now();
        const due = rows
          .filter((row) => row.status === "queued" && row.runAfter.getTime() <= now)
          .sort((a, b) => a.runAfter.getTime() - b.runAfter.getTime());
        const job = due[0];
        if (!job) return null;
        job.status = "running";
        job.lockedAt = new Date();
        job.lockedBy = workerId;
        job.attempts += 1;
        job.error = "";
        job.updatedAt = new Date();
        return { ...job };
      });
    },
    async heartbeat(jobId, workerId) {
      const job = rows.find((row) => row.id === jobId);
      if (job && job.status === "running" && job.lockedBy === workerId) {
        job.lockedAt = new Date();
        job.updatedAt = new Date();
      }
    },
    async markDone(jobId) {
      const job = rows.find((row) => row.id === jobId);
      if (!job) return;
      job.status = "done";
      job.lockedAt = null;
      job.lockedBy = null;
      job.finishedAt = new Date();
      job.updatedAt = new Date();
      job.error = "";
    },
    async markFailedOrRetry(job, error) {
      const row = rows.find((entry) => entry.id === job.id);
      if (!row) return "failed";
      const short = error.slice(0, 500);
      if (row.attempts < row.maxAttempts) {
        row.status = "queued";
        row.lockedAt = null;
        row.lockedBy = null;
        row.error = short;
        row.runAfter = new Date(Date.now() + BACKOFF_SECONDS * row.attempts * 1000);
        row.updatedAt = new Date();
        return "queued";
      }
      row.status = "failed";
      row.lockedAt = null;
      row.lockedBy = null;
      row.error = short;
      row.finishedAt = new Date();
      row.updatedAt = new Date();
      return "failed";
    },
    async releaseToQueued(jobId) {
      const job = rows.find((row) => row.id === jobId);
      if (job?.status !== "running") return;
      job.status = "queued";
      job.lockedAt = null;
      job.lockedBy = null;
      job.attempts = Math.max(job.attempts - 1, 0);
      job.updatedAt = new Date();
    },
  };
}

/** Narrow error text for storage: no stacks, no file bodies. */
export function shortJobError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.replace(/\s+/g, " ").trim();
    return message.slice(0, 500) || "handler failed";
  }
  return "handler failed";
}

/** Exported for tests that assert the SQL backoff constant. */
export const JOB_BACKOFF_SECONDS = BACKOFF_SECONDS;
