// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { copyFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Handler } from "../types.js";

/**
 * Smoke handler: reads the original through readOriginal, copies ~1 KiB into
 * the job temp dir, and returns. The engine marks the job done.
 */
export const selftestHandler: Handler = async (ctx) => {
  if (!ctx.job.documentId) throw new Error("document required");
  const original = await ctx.readOriginal(ctx.job.documentId);
  const info = await stat(original);
  if (info.size < 1) throw new Error("original empty");
  const target = path.join(ctx.tmpDir, "selftest-copy.bin");
  await copyFile(original, target);
  ctx.log.info("selftest copied original", {
    jobId: ctx.job.id,
    bytes: info.size,
  });
};
