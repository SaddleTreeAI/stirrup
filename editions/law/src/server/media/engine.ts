// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@rakazo/db";
import { shortJobError } from "./job-store.js";
import type { Handler, HandlerContext, JobStore, LawJobRow, MediaLog, Runner } from "./types.js";

export const DEFAULT_STALE_MINUTES = 120;
export const DEFAULT_CONCURRENCY = 1;
export const HEARTBEAT_MS = 30_000;
export const POLL_IDLE_MS = 1_000;

export type EngineOptions = {
  store: JobStore;
  prisma: PrismaClient;
  runner: Runner;
  handlers: Record<string, Handler>;
  workerId?: string;
  concurrency?: number;
  staleMinutes?: number;
  tmpRoot?: string;
  heartbeatMs?: number;
  idleMs?: number;
  log?: MediaLog;
  /** Build handler I/O helpers for one job (artifact read/write). */
  createHandlerIo: (input: {
    job: LawJobRow;
    tmpDir: string;
  }) => Pick<HandlerContext, "readOriginal" | "saveArtifact">;
  /** Called when the loop has nothing to claim (tests can stop after N idles). */
  onIdle?: () => void | Promise<void>;
};

export type MediaEngine = {
  workerId: string;
  start: () => Promise<void>;
  stop: (mode?: "finish" | "release") => Promise<void>;
  /** Process one claim cycle (for tests). */
  tick: () => Promise<boolean>;
};

function defaultLog(): MediaLog {
  return {
    info: (message, fields) => console.info(message, fields ?? {}),
    warn: (message, fields) => console.warn(message, fields ?? {}),
    error: (message, fields) => console.error(message, fields ?? {}),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      },
      { once: true },
    );
  });
}

export function mediaTmpRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.LAW_MEDIA_TMP?.trim() || path.join(tmpdir(), "law-media");
}

export function mediaConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.LAW_MEDIA_CONCURRENCY ?? DEFAULT_CONCURRENCY);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_CONCURRENCY;
  return Math.floor(raw);
}

export function mediaStaleMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.LAW_MEDIA_STALE_MINUTES ?? DEFAULT_STALE_MINUTES);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_STALE_MINUTES;
  return Math.floor(raw);
}

/** Claim-and-run loop over law_jobs with heartbeats, retries, and SIGTERM release. */
export function createMediaEngine(options: EngineOptions): MediaEngine {
  const workerId = options.workerId ?? `media-${randomUUID()}`;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const staleMinutes = options.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const tmpRoot = options.tmpRoot ?? mediaTmpRoot();
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const idleMs = options.idleMs ?? POLL_IDLE_MS;
  const log = options.log ?? defaultLog();

  let stopping: "finish" | "release" | null = null;
  let loopAbort: AbortController | undefined;
  let loopPromise: Promise<void> | undefined;
  const inFlight = new Set<Promise<void>>();
  const runningJobs = new Map<string, LawJobRow>();
  const releasedIds = new Set<string>();

  const runOne = async (job: LawJobRow): Promise<void> => {
    runningJobs.set(job.id, job);
    await mkdir(tmpRoot, { recursive: true });
    const jobTmp = await mkdtemp(path.join(tmpRoot, `${job.id}-`));
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      heartbeat = setInterval(() => {
        void options.store.heartbeat(job.id, workerId).catch((error) => {
          log.warn("media heartbeat failed", { jobId: job.id, error: shortJobError(error) });
        });
      }, heartbeatMs);
      // Unref so a lingering heartbeat cannot keep the process alive after stop.
      heartbeat.unref?.();

      const handler = options.handlers[job.kind];
      if (!handler) {
        if (!releasedIds.has(job.id)) {
          await options.store.markFailedOrRetry(job, `unknown kind: ${job.kind}`);
        }
        return;
      }

      const io = options.createHandlerIo({ job, tmpDir: jobTmp });
      await handler({
        job,
        prisma: options.prisma,
        runner: options.runner,
        tmpDir: jobTmp,
        readOriginal: io.readOriginal,
        saveArtifact: io.saveArtifact,
        log,
      });
      // SIGTERM may have released this row back to queued; do not flip it to done.
      if (!releasedIds.has(job.id)) await options.store.markDone(job.id);
    } catch (error) {
      if (releasedIds.has(job.id)) return;
      const message = shortJobError(error);
      log.warn("media job failed", { jobId: job.id, kind: job.kind, error: message });
      await options.store.markFailedOrRetry(job, message);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      runningJobs.delete(job.id);
      await rm(jobTmp, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const tick = async (): Promise<boolean> => {
    if (stopping) return false;
    await options.store.requeueStale(staleMinutes);
    if (inFlight.size >= concurrency) return true;

    const job = await options.store.claim(workerId);
    if (!job) {
      await options.onIdle?.();
      return false;
    }

    const work = runOne(job).finally(() => {
      inFlight.delete(work);
    });
    inFlight.add(work);
    return true;
  };

  const start = async () => {
    if (loopPromise) return loopPromise;
    await mkdir(tmpRoot, { recursive: true });
    loopAbort = new AbortController();
    loopPromise = (async () => {
      while (!stopping) {
        try {
          const claimed = await tick();
          if (stopping) break;
          if (!claimed && inFlight.size === 0) {
            await sleep(idleMs, loopAbort.signal).catch(() => undefined);
          } else if (!claimed) {
            await sleep(Math.min(idleMs, 200), loopAbort.signal).catch(() => undefined);
          }
        } catch (error) {
          if (stopping) break;
          log.error("media loop error", { error: shortJobError(error) });
          await sleep(idleMs, loopAbort.signal).catch(() => undefined);
        }
      }
      // finish: drain in-flight work. release: rows are already requeued; handlers may linger.
      if (stopping === "finish") await Promise.allSettled([...inFlight]);
    })();
    return loopPromise;
  };

  const stop = async (mode: "finish" | "release" = "release") => {
    stopping = mode;
    loopAbort?.abort();
    if (mode === "release") {
      const ids = [...runningJobs.keys()];
      for (const jobId of ids) releasedIds.add(jobId);
      await Promise.all(ids.map((jobId) => options.store.releaseToQueued(jobId)));
      // Do not await handlers: SIGTERM must return after the row is queued again.
      return;
    }
    await loopPromise;
    await Promise.allSettled([...inFlight]);
  };

  return { workerId, start, stop, tick };
}

/** Install SIGTERM/SIGINT to finish-or-release running work. */
export function installMediaSignals(engine: MediaEngine, log?: MediaLog): () => void {
  const logger = log ?? defaultLog();
  const onSignal = () => {
    logger.info("media received shutdown signal");
    void engine.stop("release");
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  return () => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };
}
