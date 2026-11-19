// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HandlerContext, LawJobRow } from "../types.js";
import { selftestHandler } from "./selftest.js";

function job(overrides: Partial<LawJobRow> = {}): LawJobRow {
  const now = new Date();
  return {
    id: "job-1",
    caseId: "case-1",
    documentId: "doc-1",
    kind: "selftest",
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    error: "",
    payload: {},
    runAfter: now,
    lockedAt: now,
    lockedBy: "w1",
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    ...overrides,
  };
}

describe("selftestHandler", () => {
  it("copies the original through readOriginal into the job temp dir", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "selftest-"));
    const original = path.join(tmpDir, "original.bin");
    const bytes = Buffer.alloc(1024, 7);
    writeFileSync(original, bytes);

    const ctx: HandlerContext = {
      job: job(),
      prisma: {} as never,
      runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
      tmpDir,
      readOriginal: async () => original,
      saveArtifact: async () => ({ id: "art" }),
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };

    await selftestHandler(ctx);
    const copied = readFileSync(path.join(tmpDir, "selftest-copy.bin"));
    expect(copied.equals(bytes)).toBe(true);
  });

  it("rejects a missing document id", async () => {
    await expect(
      selftestHandler({
        job: job({ documentId: null }),
        prisma: {} as never,
        runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
        tmpDir: mkdtempSync(path.join(tmpdir(), "selftest-")),
        readOriginal: async () => "",
        saveArtifact: async () => ({ id: "art" }),
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
    ).rejects.toThrow(/document required/);
  });
});
