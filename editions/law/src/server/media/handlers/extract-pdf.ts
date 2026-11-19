// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { randomUUID } from "node:crypto";
import { readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { sealLawText } from "../../seal.js";
import { enqueueLawJob } from "../enqueue.js";
import type { Handler, HandlerContext, Runner } from "../types.js";

export const PDF_EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;
export const PDF_PROGRESS_THROTTLE_MS = 5_000;
export const PDF_PAGE_BATCH = 200;
export const PDF_BODY_CAP = 2_000_000;
export const PDF_BLANK_CHARS = 25;
export const DEFAULT_PDF_MAX_PAGES = 2000;
export const DEFAULT_PDF_MAX_MB = 100;

const TOOL_ENV = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  HOME: "/tmp",
});

type PdfInfo = { pages: number; encrypted: boolean };

/** Local PDF text extract: pdfinfo + pdftotext only. Never opens network URLs. */
export const extractPdfHandler: Handler = async (ctx) => {
  const documentId = ctx.job.documentId;
  if (!documentId) throw new Error("document required");

  let originalPath: string | undefined;
  try {
    originalPath = await ctx.readOriginal(documentId);
    await runExtract(ctx, documentId, originalPath);
  } finally {
    if (originalPath) {
      await unlink(originalPath).catch(() => undefined);
    }
  }
};

async function runExtract(ctx: HandlerContext, documentId: string, originalPath: string) {
  const doc = await ctx.prisma.lawDocument.findUnique({
    where: { id: documentId },
    select: { id: true, caseId: true },
  });
  if (!doc) throw new Error("document missing");

  const lawCase = await ctx.prisma.lawCase.findUnique({
    where: { id: doc.caseId },
    select: { spaceId: true },
  });
  if (!lawCase) throw new Error("case missing");
  const { spaceId } = lawCase;

  await setDocumentStatus(ctx, documentId, "processing", "Reading PDF");

  const maxPages = envInt("LAW_PDF_MAX_PAGES", DEFAULT_PDF_MAX_PAGES);
  const maxMb = envInt("LAW_PDF_MAX_MB", DEFAULT_PDF_MAX_MB);
  const fileStat = await stat(originalPath);
  if (fileStat.size > maxMb * 1024 * 1024) {
    await failDocument(ctx, documentId, "PDF could not be read");
    throw new Error("pdf over size cap");
  }

  const info = await readPdfInfo(ctx.runner, originalPath, ctx.tmpDir);
  if (!info) {
    await failDocument(ctx, documentId, "PDF could not be read");
    throw new Error("pdf unreadable");
  }
  if (info.encrypted) {
    await failDocument(ctx, documentId, "PDF is password protected");
    throw new Error("pdf encrypted");
  }
  if (info.pages < 1) {
    await failDocument(ctx, documentId, "PDF could not be read");
    throw new Error("pdf no pages");
  }
  if (info.pages > maxPages) {
    await failDocument(ctx, documentId, "PDF could not be read");
    throw new Error("pdf over page cap");
  }

  const pageTexts = await extractPageTexts(ctx, originalPath, info.pages);
  const blankCount = pageTexts.filter((text) => isBlankPage(text)).length;
  const scanned = blankCount * 2 >= info.pages; // ≥ 50%

  await insertPages(ctx, {
    documentId,
    spaceId,
    pageTexts,
  });

  const body = buildBodyWithMarkers(pageTexts);
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

  if (scanned) {
    await enqueueLawJob(ctx.prisma, {
      caseId: doc.caseId,
      documentId,
      kind: "ocr_pdf",
    });
    // P2 owns OCR; until then the document is usable with this detail.
    await ctx.prisma.lawDocument.update({
      where: { id: documentId },
      data: {
        body: sealedBody,
        pageCount: info.pages,
        status: "ready",
        statusDetail: "No text found. OCR is not enabled.",
        updatedAt: new Date(),
      },
    });
    return;
  }

  await ctx.prisma.lawDocument.update({
    where: { id: documentId },
    data: {
      body: sealedBody,
      pageCount: info.pages,
      status: "ready",
      statusDetail: "",
      updatedAt: new Date(),
    },
  });
}

export function isBlankPage(text: string): boolean {
  const nonWs = text.replace(/\s+/g, "");
  return nonWs.length < PDF_BLANK_CHARS;
}

export function buildBodyWithMarkers(pageTexts: readonly string[]): string {
  const parts: string[] = [];
  let length = 0;
  for (let i = 0; i < pageTexts.length; i += 1) {
    const chunk = `\n\n[page ${i + 1}]\n\n${pageTexts[i] ?? ""}`;
    if (length + chunk.length > PDF_BODY_CAP) break;
    parts.push(chunk);
    length += chunk.length;
  }
  return parts.join("");
}

export function parsePdfInfo(stdout: string): PdfInfo | null {
  const pagesMatch = /Pages:\s*(\d+)/i.exec(stdout);
  if (!pagesMatch) return null;
  const pages = Number(pagesMatch[1]);
  if (!Number.isFinite(pages) || pages < 0) return null;
  const encMatch = /Encrypted:\s*(\S+)/i.exec(stdout);
  const encRaw = (encMatch?.[1] ?? "no").toLowerCase();
  const encrypted = encRaw !== "no" && encRaw !== "false" && encRaw !== "none";
  return { pages, encrypted };
}

async function readPdfInfo(
  runner: Runner,
  originalPath: string,
  cwd: string,
): Promise<PdfInfo | null> {
  const result = await runner.run("pdfinfo", [originalPath], {
    cwd,
    timeoutMs: 60_000,
    env: TOOL_ENV(),
  });
  if (result.code !== 0) return null;
  return parsePdfInfo(result.stdout);
}

async function extractPageTexts(
  ctx: HandlerContext,
  originalPath: string,
  pageCount: number,
): Promise<string[]> {
  const outPath = path.join(ctx.tmpDir, "pdftotext-out.txt");
  try {
    const result = await ctx.runner.run(
      "pdftotext",
      ["-layout", "-enc", "UTF-8", originalPath, outPath],
      { cwd: ctx.tmpDir, timeoutMs: PDF_EXTRACT_TIMEOUT_MS, env: TOOL_ENV() },
    );
    if (result.code === 0) {
      const raw = await readFile(outPath, "utf8").catch(() => "");
      const split = raw.split("\f");
      // pdftotext may append a trailing empty segment after the last form feed.
      while (split.length > pageCount && (split[split.length - 1] ?? "") === "") {
        split.pop();
      }
      if (split.length === pageCount) {
        return split.map((page) => page.replace(/\r\n/g, "\n"));
      }
    }
  } finally {
    await unlink(outPath).catch(() => undefined);
  }

  return extractPerPage(ctx, originalPath, pageCount);
}

async function extractPerPage(
  ctx: HandlerContext,
  originalPath: string,
  pageCount: number,
): Promise<string[]> {
  const pages: string[] = [];
  let lastProgress = 0;
  for (let page = 1; page <= pageCount; page += 1) {
    const now = Date.now();
    if (page === 1 || now - lastProgress >= PDF_PROGRESS_THROTTLE_MS) {
      lastProgress = now;
      await setDocumentStatus(
        ctx,
        ctx.job.documentId!,
        "processing",
        `Reading page ${page} of ${pageCount}`,
      );
    }
    const outPath = path.join(ctx.tmpDir, `page-${page}.txt`);
    try {
      const result = await ctx.runner.run(
        "pdftotext",
        ["-f", String(page), "-l", String(page), "-layout", "-enc", "UTF-8", originalPath, outPath],
        { cwd: ctx.tmpDir, timeoutMs: PDF_EXTRACT_TIMEOUT_MS, env: TOOL_ENV() },
      );
      if (result.code !== 0) {
        pages.push("");
        continue;
      }
      const text = await readFile(outPath, "utf8").catch(() => "");
      pages.push(text.replace(/\r\n/g, "\n").replace(/\f/g, ""));
    } finally {
      await unlink(outPath).catch(() => undefined);
    }
  }
  return pages;
}

async function insertPages(
  ctx: HandlerContext,
  input: {
    documentId: string;
    spaceId: string;
    pageTexts: readonly string[];
  },
) {
  // Replace any prior extract so retries stay idempotent.
  await ctx.prisma.lawDocumentPage.deleteMany({ where: { documentId: input.documentId } });

  const rows: Array<{ id: string; documentId: string; page: number; text: string; ocr: boolean }> =
    [];
  for (let i = 0; i < input.pageTexts.length; i += 1) {
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
      input.pageTexts[i] ?? "",
    );
    rows.push({
      id,
      documentId: input.documentId,
      page: i + 1,
      text: sealed,
      ocr: false,
    });
  }

  for (let offset = 0; offset < rows.length; offset += PDF_PAGE_BATCH) {
    const batch = rows.slice(offset, offset + PDF_PAGE_BATCH);
    await ctx.prisma.lawDocumentPage.createMany({ data: batch });
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

async function failDocument(ctx: HandlerContext, documentId: string, statusDetail: string) {
  await setDocumentStatus(ctx, documentId, "failed", statusDetail);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}
