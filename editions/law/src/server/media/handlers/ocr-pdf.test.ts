// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerContext, Runner, RunResult } from "../types.js";
import {
  alignSidecarToPages,
  DEFAULT_OCR_MAX_PAGES,
  mapOcrExitCode,
  mergeOcrPages,
  OCR_COMPLETE_DETAIL,
  ocrArgs,
  ocrJobCount,
  ocrPdfHandler,
  parseInstalledLangs,
  parseOcrProgressPage,
  splitSidecarSegments,
  validateOcrLangs,
} from "./ocr-pdf.js";

vi.mock("../../seal.js", () => ({
  sealLawText: vi.fn(
    async (_prisma: unknown, _loc: unknown, plaintext: string) => `sealed:${plaintext}`,
  ),
  openLawText: vi.fn(async (_prisma: unknown, _loc: unknown, value: string) =>
    value.startsWith("sealed:") ? value.slice("sealed:".length) : value,
  ),
}));

import { sealLawText } from "../../seal.js";

type DocUpdate = Record<string, unknown>;
type PageRow = { id: string; page: number; text: string; ocr: boolean };

function makePrisma(pages: PageRow[]) {
  const updates: DocUpdate[] = [];
  const pageUpdates: Array<{ id: string; text: string; ocr: boolean }> = [];
  const pageCreates: PageRow[] = [];
  let pageRows = [...pages];
  const prisma = {
    lawDocument: {
      findUnique: vi.fn(async () => ({
        id: "doc-1",
        caseId: "case-1",
        pageCount: pages.length || 2,
        filename: "scan.pdf",
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
      findMany: vi.fn(async () => pageRows),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: PageRow }) => {
        pageUpdates.push({ id: where.id, text: data.text, ocr: data.ocr });
        pageRows = pageRows.map((row) =>
          row.id === where.id ? { ...row, text: data.text, ocr: data.ocr } : row,
        );
        return data;
      }),
      create: vi.fn(async ({ data }: { data: PageRow }) => {
        pageCreates.push(data);
        pageRows.push(data);
        return data;
      }),
    },
  };
  return { prisma, updates, pageUpdates, pageCreates };
}

function makeRunner(
  handlers: Record<
    string,
    (
      args: string[],
      options?: { cwd?: string; onStderr?: (c: string) => void },
    ) => Promise<RunResult> | RunResult
  >,
): Runner {
  return {
    async run(cmd, args, options) {
      const handler = handlers[cmd];
      if (!handler) return { code: 1, stdout: "", stderr: `unknown ${cmd}` };
      return handler(args, options);
    },
  };
}

async function makeCtx(
  runner: Runner,
  prisma: ReturnType<typeof makePrisma>["prisma"],
  saved: Array<{ name: string; bytes: Uint8Array }> = [],
): Promise<{ ctx: HandlerContext; tmpDir: string }> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "ocr-pdf-"));
  const originalPath = path.join(tmpDir, "original.pdf");
  await writeFile(originalPath, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  const ctx: HandlerContext = {
    job: {
      id: "job-1",
      caseId: "case-1",
      documentId: "doc-1",
      kind: "ocr_pdf",
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
      const copy = path.join(tmpDir, "read-original.pdf");
      await writeFile(copy, await readFile(originalPath));
      return copy;
    },
    saveArtifact: async (input) => {
      saved.push({ name: input.name, bytes: input.bytes });
      return { id: "derived-1" };
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return { ctx, tmpDir };
}

describe("ocr helpers", () => {
  it("builds ocrmypdf argv exactly", () => {
    expect(
      ocrArgs({
        langs: "eng",
        jobs: 4,
        sidecar: "/tmp/out.txt",
        input: "/tmp/in.pdf",
        output: "/tmp/out.pdf",
      }),
    ).toEqual([
      "--skip-text",
      "--output-type",
      "pdf",
      "--optimize",
      "0",
      "--jobs",
      "4",
      "-l",
      "eng",
      "--sidecar",
      "/tmp/out.txt",
      "/tmp/in.pdf",
      "/tmp/out.pdf",
    ]);
  });

  it("caps jobs at 4 and validates language strings", () => {
    expect(ocrJobCount({ LAW_OCR_JOBS: "8" }, 16)).toBe(4);
    expect(ocrJobCount({}, 2)).toBe(2);
    expect(validateOcrLangs("eng")).toBe("eng");
    expect(validateOcrLangs("eng+spa")).toBe("eng+spa");
    expect(validateOcrLangs("ENG")).toBeNull();
    expect(validateOcrLangs("eng;spa")).toBeNull();
    expect([...parseInstalledLangs("List of available languages\neng\nspa\n")].sort()).toEqual([
      "eng",
      "spa",
    ]);
  });

  it("maps exit codes to short generic errors", () => {
    expect(mapOcrExitCode(null)).toBe("OCR timed out");
    expect(mapOcrExitCode(2)).toBe("PDF could not be read");
    expect(mapOcrExitCode(3)).toBe("OCR dependency missing");
    expect(mapOcrExitCode(6)).toBe("PDF already has text");
    expect(mapOcrExitCode(8)).toBe("PDF is password protected");
    expect(mapOcrExitCode(99)).toBe("OCR could not finish");
  });

  it("parses progress pages and keeps real text when merging OCR", () => {
    expect(parseOcrProgressPage("  2 page 3/10")).toBe(3);
    expect(parseOcrProgressPage("working")).toBeNull();
    const merged = mergeOcrPages(
      [
        { id: "p1", page: 1, text: "", ocr: false },
        { id: "p2", page: 2, text: "born digital text that is long enough", ocr: false },
        { id: "p3", page: 3, text: "   ", ocr: false },
      ],
      ["ocr one", "should not apply", "ocr three"],
      3,
    );
    expect(merged[0]).toMatchObject({ text: "ocr one", ocr: true, dirty: true });
    expect(merged[1]).toMatchObject({
      text: "born digital text that is long enough",
      ocr: false,
      dirty: false,
    });
    expect(merged[2]).toMatchObject({ text: "ocr three", ocr: true, dirty: true });
    expect(splitSidecarSegments("a\fb\f")).toEqual(["a", "b"]);
  });

  it("aligns a leading skipped range so OCR text lands on the scanned pages", () => {
    const segments = splitSidecarSegments("[OCR skipped on page(s) 1-5]\fA\fB\fC");
    expect(alignSidecarToPages(segments, 8)).toEqual(["", "", "", "", "", "A", "B", "C"]);
    const existing = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i + 1}`,
      page: i + 1,
      text: i < 5 ? "enough native text already present on this page" : "",
      ocr: false,
    }));
    const merged = mergeOcrPages(existing, segments, 8);
    expect(merged.slice(0, 5).every((row) => row.dirty === false && row.ocr === false)).toBe(true);
    expect(merged[0]?.text).toContain("enough native text");
    expect(merged[5]).toMatchObject({ text: "A", ocr: true, dirty: true });
    expect(merged[6]).toMatchObject({ text: "B", ocr: true, dirty: true });
    expect(merged[7]).toMatchObject({ text: "C", ocr: true, dirty: true });
  });

  it("aligns a single skipped page without storing the placeholder", () => {
    const segments = splitSidecarSegments("ocr one\f[OCR skipped on page(s) 2]\focr three");
    expect(alignSidecarToPages(segments, 3)).toEqual(["ocr one", "", "ocr three"]);
    const merged = mergeOcrPages(
      [
        { id: "p1", page: 1, text: "", ocr: false },
        { id: "p2", page: 2, text: "born digital text that is long enough", ocr: false },
        { id: "p3", page: 3, text: "", ocr: false },
      ],
      segments,
      3,
    );
    expect(merged[0]).toMatchObject({ text: "ocr one", ocr: true, dirty: true });
    expect(merged[1]).toMatchObject({
      text: "born digital text that is long enough",
      ocr: false,
      dirty: false,
    });
    expect(merged[2]).toMatchObject({ text: "ocr three", ocr: true, dirty: true });
    expect(merged.every((row) => !/OCR skipped/.test(row.text))).toBe(true);
  });

  it("aligns a skipped range in the middle of the sidecar", () => {
    const segments = splitSidecarSegments("A\f[OCR skipped on page(s) 2-4]\fE");
    expect(alignSidecarToPages(segments, 5)).toEqual(["A", "", "", "", "E"]);
    const merged = mergeOcrPages(
      [
        { id: "p1", page: 1, text: "", ocr: false },
        { id: "p2", page: 2, text: "enough native text already present here two", ocr: false },
        { id: "p3", page: 3, text: "enough native text already present here three", ocr: false },
        { id: "p4", page: 4, text: "enough native text already present here four", ocr: false },
        { id: "p5", page: 5, text: "", ocr: false },
      ],
      segments,
      5,
    );
    expect(merged[0]).toMatchObject({ text: "A", ocr: true, dirty: true });
    expect(merged[1]?.dirty).toBe(false);
    expect(merged[2]?.dirty).toBe(false);
    expect(merged[3]?.dirty).toBe(false);
    expect(merged[4]).toMatchObject({ text: "E", ocr: true, dirty: true });
  });
});

describe("ocrPdfHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.LAW_OCR_MAX_PAGES;
    delete process.env.LAW_OCR_LANGS;
    delete process.env.LAW_OCR_JOBS;
    delete process.env.LAW_OCR_TIMEOUT_MINUTES;
  });

  afterEach(() => {
    delete process.env.LAW_OCR_MAX_PAGES;
    delete process.env.LAW_OCR_LANGS;
  });

  it("runs ocrmypdf, replaces blank pages only, saves derived artifact, cleans temp", async () => {
    const saved: Array<{ name: string; bytes: Uint8Array }> = [];
    const { prisma, updates, pageUpdates } = makePrisma([
      { id: "p1", page: 1, text: "", ocr: false },
      { id: "p2", page: 2, text: "enough native text already present here", ocr: false },
    ]);
    const runner = makeRunner({
      tesseract: () => ({ code: 0, stdout: "List of available languages\neng\n", stderr: "" }),
      ocrmypdf: async (args, options) => {
        expect(args).toEqual(
          ocrArgs({
            langs: "eng",
            jobs: ocrJobCount(),
            sidecar: args[args.indexOf("--sidecar") + 1]!,
            input: args[args.length - 2]!,
            output: args[args.length - 1]!,
          }),
        );
        const sidecar = args[args.indexOf("--sidecar") + 1]!;
        const output = args[args.length - 1]!;
        await writeFile(sidecar, "machine page one\fshould not overwrite");
        await writeFile(output, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
        options?.onStderr?.("Scanning page 1\n");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const { ctx, tmpDir } = await makeCtx(runner, prisma, saved);
    await ocrPdfHandler(ctx);

    expect(pageUpdates).toEqual([{ id: "p1", text: "sealed:machine page one", ocr: true }]);
    expect(pageUpdates.some((row) => row.id === "p2")).toBe(false);
    expect(sealLawText).toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.name).toBe("scan-searchable.pdf");
    const ready = updates.find((row) => row.status === "ready");
    expect(ready).toMatchObject({
      derivedArtifactId: "derived-1",
      statusDetail: OCR_COMPLETE_DETAIL,
    });
    expect(ready?.body).toContain("[page 1]");
    expect(ready?.body).toContain("machine page one");
    expect(ready?.body).toContain("enough native text already present here");
    // Temp OCR outputs cleaned; job tmpDir itself may still exist.
    await expect(readFile(path.join(tmpDir, "ocr-out.pdf"))).rejects.toThrow();
    await expect(readFile(path.join(tmpDir, "ocr-sidecar.txt"))).rejects.toThrow();
  });

  it("caps oversized PDFs without running ocrmypdf", async () => {
    process.env.LAW_OCR_MAX_PAGES = "2";
    const { prisma, updates } = makePrisma([
      { id: "p1", page: 1, text: "", ocr: false },
      { id: "p2", page: 2, text: "", ocr: false },
      { id: "p3", page: 3, text: "", ocr: false },
    ]);
    prisma.lawDocument.findUnique = vi.fn(async () => ({
      id: "doc-1",
      caseId: "case-1",
      pageCount: 3,
      filename: "scan.pdf",
    }));
    let ranOcr = false;
    const runner = makeRunner({
      tesseract: () => ({ code: 0, stdout: "eng\n", stderr: "" }),
      ocrmypdf: () => {
        ranOcr = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const { ctx } = await makeCtx(runner, prisma);
    await ocrPdfHandler(ctx);
    expect(ranOcr).toBe(false);
    expect(updates.some((row) => row.statusDetail === `OCR skipped: more than 2 pages`)).toBe(true);
    expect(DEFAULT_OCR_MAX_PAGES).toBe(400);
  });

  it("rejects missing language packs and maps ocrmypdf failures", async () => {
    process.env.LAW_OCR_LANGS = "eng+deu";
    const { prisma, updates } = makePrisma([{ id: "p1", page: 1, text: "", ocr: false }]);
    const runner = makeRunner({
      tesseract: () => ({ code: 0, stdout: "eng\n", stderr: "" }),
    });
    const { ctx } = await makeCtx(runner, prisma);
    await expect(ocrPdfHandler(ctx)).rejects.toThrow("OCR language pack missing");
    expect(updates.some((row) => row.statusDetail === "OCR language pack missing")).toBe(true);

    vi.clearAllMocks();
    delete process.env.LAW_OCR_LANGS;
    const again = makePrisma([{ id: "p1", page: 1, text: "", ocr: false }]);
    const failRunner = makeRunner({
      tesseract: () => ({ code: 0, stdout: "eng\n", stderr: "" }),
      ocrmypdf: () => ({ code: 6, stdout: "", stderr: "" }),
    });
    const second = await makeCtx(failRunner, again.prisma);
    await expect(ocrPdfHandler(second.ctx)).rejects.toThrow("PDF already has text");
    expect(again.updates.some((row) => row.statusDetail === "PDF already has text")).toBe(true);
  });
});
