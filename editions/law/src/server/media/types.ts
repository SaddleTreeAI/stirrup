// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { PrismaClient } from "@rakazo/db";

/** Row shape returned by claim / raw updates on law_jobs. */
export type LawJobRow = {
  id: string;
  caseId: string;
  documentId: string | null;
  kind: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  error: string;
  payload: unknown;
  runAfter: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
};

export type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type Runner = {
  run(
    cmd: string,
    args: string[],
    options?: {
      cwd?: string;
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
      /** Streaming stdout chunks (for ASR progress lines). */
      onStdout?: (chunk: string) => void | Promise<void>;
      /** Streaming stderr chunks (for OCR progress lines). */
      onStderr?: (chunk: string) => void | Promise<void>;
    },
  ): Promise<RunResult>;
};

export type MediaLog = {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
};

export type HandlerContext = {
  job: LawJobRow;
  prisma: PrismaClient;
  runner: Runner;
  tmpDir: string;
  /** Decrypts the document's original artifact into a temp file and returns its path. */
  readOriginal: (documentId: string) => Promise<string>;
  /** Seals bytes into the shared artifact store; returns the new artifact id. */
  saveArtifact: (input: {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    spaceId: string;
    userId?: string;
  }) => Promise<{ id: string }>;
  log: MediaLog;
};

export type Handler = (ctx: HandlerContext) => Promise<void>;

export type JobStore = {
  /** Requeues jobs stuck in running longer than staleMinutes. */
  requeueStale: (staleMinutes: number) => Promise<number>;
  /** Claims one due queued job (SKIP LOCKED). Returns null when none. */
  claim: (workerId: string) => Promise<LawJobRow | null>;
  heartbeat: (jobId: string, workerId: string) => Promise<void>;
  markDone: (jobId: string) => Promise<void>;
  /**
   * On failure: requeue with backoff while attempts < maxAttempts, else mark failed.
   * `error` must be short and free of stacks or file contents.
   */
  markFailedOrRetry: (job: LawJobRow, error: string) => Promise<"queued" | "failed">;
  /** Release a running job back to queued (graceful shutdown). */
  releaseToQueued: (jobId: string) => Promise<void>;
};
