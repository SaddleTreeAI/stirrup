// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { cpus } from "node:os";
import path from "node:path";
import { openLawText, sealLawText } from "../../seal.js";
import type { Handler, HandlerContext, Runner } from "../types.js";
import { buildBodyWithMarkers, isBlankPage, parsePdfInfo } from "./extract-pdf.js";

export const DEFAULT_OCR_MAX_PAGES = 400;
export const DEFAULT_OCR_TIMEOUT_MINUTES = 120;
export const DEFAULT_OCR_LANGS = "eng";
export const OCR_PROGRESS_THROTTLE_MS = 10_000;
export const OCR_COMPLETE_DETAIL = "OCR complete (machine-read text; check against the original)";

const LANG_PATTERN = /^[a-z_]{3,8}(\+[a-z_]{3,8})*$/;

const TOOL_ENV = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  HOME: "/tmp",
});

type ExistingPage = { id: string; page: number; text: string; ocr: boolean };

/** Local OCR for mostly-scanned PDFs: ocrmypdf + tesseract only. Never opens network URLs. */
export const ocrPdfHandler: Handler = async (ctx) => {
  const documentId = ctx.job.documentId;
  if (!documentId) throw new Error("document required");

  let originalPath: string | undefined;
  try {
    originalPath = await ctx.readOriginal(documentId);
    await runOcr(ctx, documentId, originalPath);
  } finally {
    if (originalPath) {
      await unlink(originalPath).catch(() => undefined);
    }
  }
};

async function runOcr(ctx: HandlerContext, documentId: string, originalPath: string) {
  const doc = await ctx.prisma.lawDocument.findUnique({
    where: { id: documentId },
    select: { id: true, caseId: true, pageCount: true, filename: true },
  });
  if (!doc) throw new Error("document missing");

  const lawCase = await ctx.prisma.lawCase.findUnique({
    where: { id: doc.caseId },
    select: { spaceId: true },
  });
  if (!lawCase) throw new Error("case missing");
  const { spaceId } = lawCase;

  const maxPages = envInt("LAW_OCR_MAX_PAGES", DEFAULT_OCR_MAX_PAGES);
  let pageCount: number;
  try {
    pageCount = await resolvePageCount(ctx, originalPath, doc.pageCount);
  } catch {
    await setDocumentStatus(ctx, documentId, "failed", "PDF could not be read");
    throw new Error("PDF could not be read");
  }
  if (pageCount > maxPages) {
    await setDocumentStatus(ctx, documentId, "ready", `OCR skipped: more than ${maxPages} pages`);
    return;
  }

  let langs: string;
  try {
    langs = await resolveOcrLangs(ctx.runner, ctx.tmpDir);
  } catch (error) {
    const detail =
      error instanceof Error && error.message === "OCR language pack missing"
        ? "OCR language pack missing"
        : "OCR language not allowed";
    await setDocumentStatus(ctx, documentId, "failed", detail);
    throw new Error(detail);
  }

  const jobs = ocrJobCount();
  const timeoutMs = envInt("LAW_OCR_TIMEOUT_MINUTES", DEFAULT_OCR_TIMEOUT_MINUTES) * 60_000;

  await setDocumentStatus(ctx, documentId, "processing", "Reading scanned pages");

  const outPdf = path.join(ctx.tmpDir, "ocr-out.pdf");
  const sidecar = path.join(ctx.tmpDir, "ocr-sidecar.txt");
  const args = ocrArgs({
    langs,
    jobs,
    sidecar,
    input: originalPath,
    output: outPdf,
  });

  let lastProgress = 0;
  const result = await ctx.runner.run("ocrmypdf", args, {
    cwd: ctx.tmpDir,
    timeoutMs,
    env: TOOL_ENV(),
    onStderr: async (chunk) => {
      const now = Date.now();
      if (now - lastProgress < OCR_PROGRESS_THROTTLE_MS) return;
      lastProgress = now;
      const page = parseOcrProgressPage(chunk);
      const detail = page !== null ? `Reading page ${page}` : "Reading scanned pages";
      await setDocumentStatus(ctx, documentId, "processing", detail);
    },
  });

  if (result.code !== 0) {
    const detail = mapOcrExitCode(result.code);
    await setDocumentStatus(ctx, documentId, "failed", detail);
    throw new Error(detail);
  }

  let sidecarText = "";
  let outBytes: Uint8Array;
  try {
    sidecarText = await readFile(sidecar, "utf8");
    outBytes = await readFile(outPdf);
  } finally {
    await unlink(sidecar).catch(() => undefined);
    await unlink(outPdf).catch(() => undefined);
  }

  const existing = await loadExistingPages(ctx, documentId, spaceId);
  const ocrSegments = splitSidecarSegments(sidecarText);
  const merged = mergeOcrPages(existing, ocrSegments, pageCount);

  await writeUpdatedPages(ctx, { documentId, spaceId, merged });

  const body = buildBodyWithMarkers(merged.map((row) => row.text));
  const sealedBody = await sealLawText(
    ctx.prisma,
    {
      table: "law_documents",
      column: "body",
      rowId: documentId,
      spaceId,
      owner: doc.caseId,
    },
    body,
  );

  const derived = await ctx.saveArtifact({
    name: searchableName(doc.filename || "document.pdf"),
    mimeType: "application/pdf",
    bytes: outBytes,
    spaceId,
  });

  await ctx.prisma.lawDocument.update({
    where: { id: documentId },
    data: {
      body: sealedBody,
      pageCount: merged.length || pageCount,
      derivedArtifactId: derived.id,
      status: "ready",
      statusDetail: OCR_COMPLETE_DETAIL,
      updatedAt: new Date(),
    },
  });
}

export function ocrArgs(input: {
  langs: string;
  jobs: number;
  sidecar: string;
  input: string;
  output: string;
}): string[] {
  return [
    "--skip-text",
    "--output-type",
    "pdf",
    "--optimize",
    "0",
    "--jobs",
    String(input.jobs),
    "-l",
    input.langs,
    "--sidecar",
    input.sidecar,
    input.input,
    input.output,
  ];
}

export function ocrJobCount(
  env: NodeJS.ProcessEnv = process.env,
  cpuCount = cpus().length,
): number {
  const raw = env.LAW_OCR_JOBS;
  if (raw !== undefined && raw !== "") {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 1) return Math.min(4, Math.floor(value));
  }
  return Math.min(4, Math.max(1, cpuCount));
}

export function validateOcrLangs(raw: string): string | null {
  const trimmed = raw.trim();
  if (!LANG_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function parseInstalledLangs(listOutput: string): Set<string> {
  const langs = new Set<string>();
  for (const line of listOutput.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.toLowerCase().startsWith("list of")) continue;
    langs.add(value);
  }
  return langs;
}

export function mapOcrExitCode(code: number | null): string {
  if (code === null) return "OCR timed out";
  switch (code) {
    case 1:
      return "OCR could not run";
    case 2:
      return "PDF could not be read";
    case 3:
      return "OCR language pack missing";
    case 6:
      return "PDF already has text";
    case 8:
      return "PDF is password protected";
    default:
      return "OCR could not finish";
  }
}

export function parseOcrProgressPage(chunk: string): number | null {
  const match = /page\s+(\d+)/i.exec(chunk);
  if (!match) return null;
  const page = Number(match[1]);
  if (!Number.isFinite(page) || page < 1) return null;
  return Math.floor(page);
}

/** Split sidecar on form feed; drop a trailing empty segment. */
export function splitSidecarSegments(raw: string): string[] {
  const split = raw.replace(/\r\n/g, "\n").split("\f");
  while (split.length > 0 && (split[split.length - 1] ?? "") === "") {
    split.pop();
  }
  return split.map((page) => page.replace(/\f/g, ""));
}

/**
 * Keep pages that already had real text; fill blank pages from the sidecar.
 * When the sidecar length matches the page count, align by index (skipped pages
 * are empty). Otherwise assign sidecar segments to blank pages in order.
 */
export function mergeOcrPages(
  existing: readonly ExistingPage[],
  ocrSegments: readonly string[],
  pageCount: number,
): Array<{ id?: string; page: number; text: string; ocr: boolean; dirty: boolean }> {
  const byPage = new Map(existing.map((row) => [row.page, row]));
  const count = Math.max(pageCount, existing.length, 1);
  const blankIndexes: number[] = [];
  const base: Array<{ id?: string; page: number; text: string; ocr: boolean }> = [];

  for (let i = 0; i < count; i += 1) {
    const page = i + 1;
    const prior = byPage.get(page);
    const text = prior?.text ?? "";
    base.push({ id: prior?.id, page, text, ocr: prior?.ocr ?? false });
    if (!prior || isBlankPage(text)) blankIndexes.push(i);
  }

  const aligned =
    ocrSegments.length === count
      ? ocrSegments
      : alignSegmentsToBlanks(count, blankIndexes, ocrSegments);

  return base.map((row, i) => {
    if (!isBlankPage(row.text)) {
      return { ...row, dirty: false };
    }
    const ocrText = aligned[i] ?? "";
    return { id: row.id, page: row.page, text: ocrText, ocr: true, dirty: true };
  });
}

function alignSegmentsToBlanks(
  count: number,
  blankIndexes: readonly number[],
  segments: readonly string[],
): string[] {
  const aligned = Array.from({ length: count }, () => "");
  for (let i = 0; i < blankIndexes.length; i += 1) {
    const at = blankIndexes[i]!;
    aligned[at] = segments[i] ?? "";
  }
  return aligned;
}

async function resolveOcrLangs(runner: Runner, cwd: string): Promise<string> {
  const requested = validateOcrLangs(process.env.LAW_OCR_LANGS ?? DEFAULT_OCR_LANGS);
  if (!requested) throw new Error("OCR language not allowed");

  const listed = await runner.run("tesseract", ["--list-langs"], {
    cwd,
    timeoutMs: 15_000,
    env: TOOL_ENV(),
  });
  const installed = parseInstalledLangs(`${listed.stdout}\n${listed.stderr}`);
  for (const lang of requested.split("+")) {
    if (!installed.has(lang)) throw new Error("OCR language pack missing");
  }
  return requested;
}

async function resolvePageCount(
  ctx: HandlerContext,
  originalPath: string,
  stored: number | null,
): Promise<number> {
  if (stored !== null && stored !== undefined && stored > 0) return stored;
  const info = await ctx.runner.run("pdfinfo", [originalPath], {
    cwd: ctx.tmpDir,
    timeoutMs: 60_000,
    env: TOOL_ENV(),
  });
  if (info.code !== 0) throw new Error("PDF could not be read");
  const parsed = parsePdfInfo(info.stdout);
  if (!parsed || parsed.pages < 1) throw new Error("PDF could not be read");
  return parsed.pages;
}

async function loadExistingPages(
  ctx: HandlerContext,
  documentId: string,
  spaceId: string,
): Promise<ExistingPage[]> {
  const rows = await ctx.prisma.lawDocumentPage.findMany({
    where: { documentId },
    select: { id: true, page: true, text: true, ocr: true },
    orderBy: { page: "asc" },
  });
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      page: row.page,
      ocr: row.ocr,
      text: await openLawText(
        ctx.prisma,
        {
          table: "law_document_pages",
          column: "text",
          rowId: row.id,
          spaceId,
          owner: documentId,
        },
        row.text,
      ),
    })),
  );
}

async function writeUpdatedPages(
  ctx: HandlerContext,
  input: {
    documentId: string;
    spaceId: string;
    merged: readonly {
      id?: string;
      page: number;
      text: string;
      ocr: boolean;
      dirty: boolean;
    }[];
  },
) {
  for (const row of input.merged) {
    if (!row.dirty) continue;
    if (row.id) {
      const sealed = await sealLawText(
        ctx.prisma,
        {
          table: "law_document_pages",
          column: "text",
          rowId: row.id,
          spaceId: input.spaceId,
          owner: input.documentId,
        },
        row.text,
      );
      await ctx.prisma.lawDocumentPage.update({
        where: { id: row.id },
        data: { text: sealed, ocr: true },
      });
      continue;
    }
    const id = randomUUID();
    const sealed = await sealLawText(
      ctx.prisma,
      {
        table: "law_document_pages",
        column: "text",
        rowId: id,
        spaceId: input.spaceId,
        owner: input.documentId,
      },
      row.text,
    );
    await ctx.prisma.lawDocumentPage.create({
      data: {
        id,
        documentId: input.documentId,
        page: row.page,
        text: sealed,
        ocr: true,
      },
    });
  }
}

async function setDocumentStatus(
  ctx: HandlerContext,
  documentId: string,
  status: string,
  statusDetail: string,
) {
  await ctx.prisma.lawDocument.update({
    where: { id: documentId },
    data: { status, statusDetail, updatedAt: new Date() },
  });
}

function searchableName(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "") || "document";
  return `${base}-searchable.pdf`;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}
