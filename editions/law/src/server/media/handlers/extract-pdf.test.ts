// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerContext, Runner, RunResult } from "../types.js";
import {
  buildBodyWithMarkers,
  extractPdfHandler,
  isBlankPage,
  PDF_BLANK_CHARS,
  PDF_PROGRESS_THROTTLE_MS,
  parsePdfInfo,
} from "./extract-pdf.js";

vi.mock("../../seal.js", () => ({
  sealLawText: vi.fn(
    async (_prisma: unknown, _loc: unknown, plaintext: string) => `sealed:${plaintext}`,
  ),
}));

import { sealLawText } from "../../seal.js";

type DocUpdate = { status?: string; statusDetail?: string; pageCount?: number; body?: string };

function makePrisma(options?: { pages?: number; sizeBytes?: number }) {
  const updates: DocUpdate[] = [];
  const createdPages: Array<{ page: number; text: string; ocr: boolean }> = [];
  const jobs: Array<{ kind: string }> = [];
  const prisma = {
    lawDocument: {
      findUnique: vi.fn(async () => ({
        id: "doc-1",
        caseId: "case-1",
      })),
      update: vi.fn(async ({ data }: { data: DocUpdate }) => {
        updates.push(data);
        return data;
      }),
    },
    lawCase: {
      findUnique: vi.fn(async () => ({ spaceId: "space-1" })),
    },
    lawDocumentPage: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(
        async ({ data }: { data: Array<{ page: number; text: string; ocr: boolean }> }) => {
          createdPages.push(...data);
          return { count: data.length };
        },
      ),
    },
    lawJob: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: { kind: string } }) => {
        jobs.push({ kind: data.kind });
        return { id: `job-${jobs.length}` };
      }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  return { prisma, updates, createdPages, jobs, sizeBytes: options?.sizeBytes ?? 100 };
}

function makeRunner(
  handlers: Record<string, (args: string[], cwd?: string) => Promise<RunResult> | RunResult>,
): Runner {
  return {
    async run(cmd, args, options) {
      const key = cmd;
      const handler = handlers[key];
      if (!handler) return { code: 1, stdout: "", stderr: `unknown ${cmd}` };
      return handler(args, options?.cwd);
    },
  };
}

async function makeCtx(
  runner: Runner,
  prisma: ReturnType<typeof makePrisma>["prisma"],
  originalBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]),
): Promise<{ ctx: HandlerContext; tmpDir: string; originalPath: string }> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "extract-pdf-"));
  const originalPath = path.join(tmpDir, "original.pdf");
  await writeFile(originalPath, originalBytes);
  const ctx: HandlerContext = {
    job: {
      id: "job-1",
      caseId: "case-1",
      documentId: "doc-1",
      kind: "extract_pdf",
      status: "running",
      attempts: 1,
      maxAttempts: 3,
      error: "",
      payload: {},
      runAfter: new Date(),
      lockedAt: new Date(),
      lockedBy: "worker",
      createdAt: new Date(),
      updatedAt: new Date(),
      finishedAt: null,
    },
    prisma: prisma as never,
    runner,
    tmpDir,
    readOriginal: async () => {
      // Return a copy so the handler's finally unlink does not remove the fixture twice.
      const copy = path.join(tmpDir, "read-original.pdf");
      await writeFile(copy, await readFile(originalPath));
      return copy;
    },
    saveArtifact: async () => ({ id: "artifact-1" }),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return { ctx, tmpDir, originalPath };
}

describe("parsePdfInfo / helpers", () => {
  it("parses pages and encrypted flag", () => {
    expect(parsePdfInfo("Pages:          3\nEncrypted:      no\n")).toEqual({
      pages: 3,
      encrypted: false,
    });
    expect(parsePdfInfo("Pages: 2\nEncrypted: yes\n")).toEqual({ pages: 2, encrypted: true });
    expect(parsePdfInfo("no pages")).toBeNull();
  });

  it("detects blank pages under the character threshold", () => {
    expect(isBlankPage("   \n")).toBe(true);
    expect(isBlankPage("x".repeat(PDF_BLANK_CHARS - 1))).toBe(true);
    expect(isBlankPage("x".repeat(PDF_BLANK_CHARS))).toBe(false);
  });

  it("caps the body with page markers", () => {
    const body = buildBodyWithMarkers(["alpha", "beta"]);
    expect(body).toContain("[page 1]");
    expect(body).toContain("alpha");
    expect(body).toContain("[page 2]");
  });
});

describe("extractPdfHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.LAW_PDF_MAX_PAGES;
    delete process.env.LAW_PDF_MAX_MB;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("extracts form-feed pages, seals writes, and marks ready", async () => {
    const { prisma, updates, createdPages } = makePrisma();
    const runner = makeRunner({
      pdfinfo: () => ({ code: 0, stdout: "Pages: 3\nEncrypted: no\n", stderr: "" }),
      pdftotext: async (args, cwd) => {
        const out = args[args.length - 1]!;
        const target = path.isAbsolute(out) ? out : path.join(cwd ?? "", out);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(
          target,
          "page one has enough non-whitespace characters here\fpage two caffeine hit with more words\fpage three closing remarks for the record",
        );
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const { ctx } = await makeCtx(runner, prisma);
    await extractPdfHandler(ctx);
    expect(createdPages).toHaveLength(3);
    expect(createdPages.every((row) => row.text.startsWith("sealed:"))).toBe(true);
    expect(createdPages.every((row) => row.ocr === false)).toBe(true);
    expect(sealLawText).toHaveBeenCalled();
    const ready = updates.find((row) => row.status === "ready");
    expect(ready).toMatchObject({ pageCount: 3, statusDetail: "" });
    expect(ready?.body).toContain("sealed:");
  });

  it("fails encrypted PDFs with a generic client detail", async () => {
    const { prisma, updates } = makePrisma();
    const runner = makeRunner({
      pdfinfo: () => ({ code: 0, stdout: "Pages: 1\nEncrypted: yes\n", stderr: "" }),
    });
    const { ctx } = await makeCtx(runner, prisma);
    await expect(extractPdfHandler(ctx)).rejects.toThrow(/encrypted/i);
    expect(
      updates.some(
        (row) => row.status === "failed" && row.statusDetail === "PDF is password protected",
      ),
    ).toBe(true);
  });

  it("fails when pdfinfo cannot read the file", async () => {
    const { prisma, updates } = makePrisma();
    const runner = makeRunner({
      pdfinfo: () => ({ code: 1, stdout: "", stderr: "boom" }),
    });
    const { ctx } = await makeCtx(runner, prisma);
    await expect(extractPdfHandler(ctx)).rejects.toThrow(/unreadable/i);
    expect(updates.some((row) => row.statusDetail === "PDF could not be read")).toBe(true);
  });

  it("fails over the page cap", async () => {
    process.env.LAW_PDF_MAX_PAGES = "2";
    const { prisma, updates } = makePrisma();
    const runner = makeRunner({
      pdfinfo: () => ({ code: 0, stdout: "Pages: 3\nEncrypted: no\n", stderr: "" }),
    });
    const { ctx } = await makeCtx(runner, prisma);
    await expect(extractPdfHandler(ctx)).rejects.toThrow(/page cap/i);
    expect(updates.some((row) => row.status === "failed")).toBe(true);
  });

  it("fails over the size cap", async () => {
    process.env.LAW_PDF_MAX_MB = "0"; // envInt rejects <1 and falls back — use 1 with huge file instead
    process.env.LAW_PDF_MAX_MB = "1";
    const { prisma, updates } = makePrisma();
    const runner = makeRunner({
      pdfinfo: () => ({ code: 0, stdout: "Pages: 1\nEncrypted: no\n", stderr: "" }),
    });
    const huge = new Uint8Array(1 * 1024 * 1024 + 1);
    const { ctx } = await makeCtx(runner, prisma, huge);
    await expect(extractPdfHandler(ctx)).rejects.toThrow(/size cap/i);
    expect(updates.some((row) => row.statusDetail === "PDF could not be read")).toBe(true);
  });

  it("does not enqueue OCR at 49% blank pages", async () => {
    const { prisma, jobs, updates } = makePrisma();
    // 2 blank of 5 = 40%; need 49%: 49 blank of 100 is heavy — use 1 blank of 3 ≈ 33%, and 1 of 2 = 50%.
    // 49%: use 49 pages with 24 blank → 48.97%; 25 blank of 50 = 50%.
    // Compact: 2 pages, 0 blank = 0%; for 49% use 100 pages synthetically via form feed.
    const pages = Array.from({ length: 100 }, (_, i) =>
      i < 49 ? "   " : "enough non-whitespace characters here for a real page",
    );
    const runner = makeRunner({
      pdfinfo: () => ({ code: 0, stdout: "Pages: 100\nEncrypted: no\n", stderr: "" }),
      pdftotext: async (args, cwd) => {
        const out = args[args.length - 1]!;
        const target = path.isAbsolute(out) ? out : path.join(cwd ?? "", out);
        await writeFile(target, pages.join("\f"));
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const { ctx } = await makeCtx(runner, prisma);
    await extractPdfHandler(ctx);
    expect(jobs).toEqual([]);
    expect(updates.some((row) => row.status === "ready" && row.statusDetail === "")).toBe(true);
  });

  it("enqueues OCR at 50% blank and sets the OCR-not-enabled detail", async () => {
    const { prisma, jobs, updates } = makePrisma();
    const pages = Array.from({ length: 4 }, (_, i) =>
      i < 2 ? "   " : "enough non-whitespace characters here for a real page",
    );
    const runner = makeRunner({
      pdfinfo: () => ({ code: 0, stdout: "Pages: 4\nEncrypted: no\n", stderr: "" }),
      pdftotext: async (args, cwd) => {
        const out = args[args.length - 1]!;
        const target = path.isAbsolute(out) ? out : path.join(cwd ?? "", out);
        await writeFile(target, pages.join("\f"));
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const { ctx } = await makeCtx(runner, prisma);
    await extractPdfHandler(ctx);
    expect(jobs).toEqual([{ kind: "ocr_pdf" }]);
    expect(
      updates.some(
        (row) =>
          row.status === "ready" && row.statusDetail === "No text found. OCR is not enabled.",
      ),
    ).toBe(true);
  });

  it("falls back to per-page extraction when form-feed count mismatches", async () => {
    const { prisma, createdPages } = makePrisma();
    let calls = 0;
    const runner = makeRunner({
      pdfinfo: () => ({ code: 0, stdout: "Pages: 2\nEncrypted: no\n", stderr: "" }),
      pdftotext: async (args, cwd) => {
        calls += 1;
        const out = args[args.length - 1]!;
        const target = path.isAbsolute(out) ? out : path.join(cwd ?? "", out);
        if (!args.includes("-f")) {
          await writeFile(target, "only one page without enough feeds");
          return { code: 0, stdout: "", stderr: "" };
        }
        const page = args[args.indexOf("-f") + 1];
        await writeFile(target, `per-page ${page} text with content`);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const { ctx } = await makeCtx(runner, prisma);
    await extractPdfHandler(ctx);
    expect(calls).toBeGreaterThan(1);
    expect(createdPages).toHaveLength(2);
    expect(createdPages[0]?.text).toContain("per-page 1");
  });

  it("throttles progress updates to at most every 5 seconds", async () => {
    const { prisma, updates } = makePrisma();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const runner = makeRunner({
      pdfinfo: () => ({ code: 0, stdout: "Pages: 3\nEncrypted: no\n", stderr: "" }),
      pdftotext: async (args, cwd) => {
        const out = args[args.length - 1]!;
        const target = path.isAbsolute(out) ? out : path.join(cwd ?? "", out);
        if (!args.includes("-f")) {
          await writeFile(target, "mismatch");
          return { code: 0, stdout: "", stderr: "" };
        }
        const page = Number(args[args.indexOf("-f") + 1]);
        await writeFile(target, `page ${page} with enough characters`);
        // Advance after the page's progress check so the next iteration sees the delta.
        if (page === 1) now += PDF_PROGRESS_THROTTLE_MS - 1;
        if (page === 2) now += PDF_PROGRESS_THROTTLE_MS;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const { ctx } = await makeCtx(runner, prisma);
    await extractPdfHandler(ctx);
    const progress = updates.filter((row) => row.statusDetail?.startsWith("Reading page"));
    // page 1 always; page 2 within throttle skipped; page 3 after throttle
    expect(progress.map((row) => row.statusDetail)).toEqual([
      "Reading page 1 of 3",
      "Reading page 3 of 3",
    ]);
  });

  it("passes a minimal env to tools and never opens a URL", async () => {
    const { prisma } = makePrisma();
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];
    const runner: Runner = {
      async run(cmd, args, options) {
        envs.push(options?.env);
        expect(args.every((arg) => !/^https?:/i.test(arg))).toBe(true);
        if (cmd === "pdfinfo") {
          return { code: 0, stdout: "Pages: 1\nEncrypted: no\n", stderr: "" };
        }
        const out = args[args.length - 1]!;
        await writeFile(out, "enough non-whitespace characters for one page");
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const { ctx } = await makeCtx(runner, prisma);
    await extractPdfHandler(ctx);
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) {
      expect(env).toBeDefined();
      expect(env?.PATH).toBeTruthy();
      expect(env?.LANG).toBe("C.UTF-8");
    }
  });
});
