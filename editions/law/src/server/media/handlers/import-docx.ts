// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { readFile, stat } from "node:fs/promises";
import { unzipSync } from "fflate";
import mammoth from "mammoth";
import { sealLawText } from "../../seal.js";
import type { Handler, HandlerContext } from "../types.js";

const TEXT_BODY_CAP = 2_000_000;
const DEFAULT_MAX_MB = 50;
const UNCOMPRESSED_CAP_BYTES = 200 * 1024 * 1024;
/** Reject archives that expand more than this relative to their compressed size. */
const EXPANSION_RATIO_CAP = 100;

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;

const GENERIC_READ_ERROR = "Couldn't read this document";
const GENERIC_SIZE_ERROR = "File too large";
const GENERIC_BOMB_ERROR = "Couldn't read this document";

export type DocxZipEntry = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
};

/** Env-tunable compressed size cap (default 50 MB). */
export function docxMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.LAW_DOCX_MAX_MB ?? DEFAULT_MAX_MB);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_MB * 1024 * 1024;
  return Math.floor(raw) * 1024 * 1024;
}

/**
 * Read the ZIP central directory only (no inflate). Used to reject zip bombs
 * and encrypted packages before mammoth opens the archive.
 */
export function listZipCentralDirectory(bytes: Uint8Array): DocxZipEntry[] {
  if (bytes.byteLength < 22) throw new Error(GENERIC_READ_ERROR);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const searchFrom = Math.max(0, bytes.byteLength - 65_536);
  for (let i = bytes.byteLength - 22; i >= searchFrom; i--) {
    if (view.getUint32(i, true) === ZIP_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(GENERIC_READ_ERROR);

  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (centralOffset + centralSize > bytes.byteLength) throw new Error(GENERIC_READ_ERROR);

  const entries: DocxZipEntry[] = [];
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > bytes.byteLength) throw new Error(GENERIC_READ_ERROR);
    if (view.getUint32(offset, true) !== ZIP_CENTRAL) throw new Error(GENERIC_READ_ERROR);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > bytes.byteLength) throw new Error(GENERIC_READ_ERROR);
    const name = new TextDecoder("utf-8").decode(bytes.subarray(nameStart, nameEnd));
    entries.push({ name, compressedSize, uncompressedSize });
    offset = nameEnd + extraLen + commentLen;
  }
  return entries;
}

/** Reject oversized or highly-compressible ZIP payloads before inflate. */
export function assertSafeDocxZip(entries: readonly DocxZipEntry[]): void {
  let uncompressedTotal = 0;
  let compressedTotal = 0;
  for (const entry of entries) {
    uncompressedTotal += entry.uncompressedSize;
    compressedTotal += entry.compressedSize;
    if (uncompressedTotal > UNCOMPRESSED_CAP_BYTES) throw new Error(GENERIC_BOMB_ERROR);
  }
  if (uncompressedTotal > UNCOMPRESSED_CAP_BYTES) throw new Error(GENERIC_BOMB_ERROR);
  if (compressedTotal > 0 && uncompressedTotal / compressedTotal > EXPANSION_RATIO_CAP) {
    throw new Error(GENERIC_BOMB_ERROR);
  }
}

export function docxLooksEncrypted(entries: readonly DocxZipEntry[]): boolean {
  return entries.some((entry) => {
    const base = entry.name.split("/").pop() ?? entry.name;
    return base === "EncryptedPackage" || base === "EncryptionInfo";
  });
}

export function docxHasTrackedChanges(documentXml: string): boolean {
  return /<w:(ins|del)\b/i.test(documentXml);
}

/** Flatten headings, paragraphs, lists, and tables to plain text via mammoth. */
export async function extractDocxText(bytes: Uint8Array): Promise<{
  text: string;
  trackedChanges: boolean;
}> {
  const entries = listZipCentralDirectory(bytes);
  assertSafeDocxZip(entries);
  if (docxLooksEncrypted(entries)) throw new Error(GENERIC_READ_ERROR);

  const documentEntry = entries.find(
    (entry) => entry.name === "word/document.xml" || entry.name.endsWith("/word/document.xml"),
  );
  if (!documentEntry) throw new Error(GENERIC_READ_ERROR);

  // Inflate only document.xml for the tracked-change scan; mammoth opens the
  // whole archive again for text. Safe: sizes already capped above.
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes, {
      filter: (file) =>
        file.name === "word/document.xml" || file.name.endsWith("/word/document.xml"),
    });
  } catch {
    throw new Error(GENERIC_READ_ERROR);
  }
  const xmlBytes =
    unzipped["word/document.xml"] ??
    Object.entries(unzipped).find(([name]) => name.endsWith("/word/document.xml"))?.[1];
  if (!xmlBytes) throw new Error(GENERIC_READ_ERROR);
  const documentXml = new TextDecoder("utf-8").decode(xmlBytes);
  const trackedChanges = docxHasTrackedChanges(documentXml);

  let raw: string;
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    raw = result.value ?? "";
  } catch {
    throw new Error(GENERIC_READ_ERROR);
  }

  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  return { text, trackedChanges };
}

function statusDetailFor(trackedChanges: boolean): string {
  const base = "Word document: no page numbers";
  return trackedChanges ? `${base} (tracked changes present)` : base;
}

async function markFailed(ctx: HandlerContext, documentId: string, detail: string): Promise<void> {
  await ctx.prisma.lawDocument.update({
    where: { id: documentId },
    data: { status: "failed", statusDetail: detail, updatedAt: new Date() },
  });
}

/**
 * import_docx: extract plain text from a Word .docx into the document body.
 * Images, text boxes, headers/footers, and footnotes are dropped (mammoth raw
 * text walks the main document story only). Comments and tracked changes keep
 * only the final text; presence of w:ins/w:del is noted in statusDetail.
 */
export const importDocxHandler: Handler = async (ctx) => {
  if (!ctx.job.documentId) throw new Error("document required");
  const documentId = ctx.job.documentId;

  const doc = await ctx.prisma.lawDocument.findUnique({
    where: { id: documentId },
    select: { id: true, caseId: true },
  });
  if (!doc) throw new Error("document required");

  const original = await ctx.readOriginal(documentId);
  const info = await stat(original);
  const maxBytes = docxMaxBytes();
  if (info.size > maxBytes) {
    await markFailed(ctx, documentId, GENERIC_SIZE_ERROR);
    throw new Error(GENERIC_SIZE_ERROR);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(original);
  } catch {
    await markFailed(ctx, documentId, GENERIC_READ_ERROR);
    throw new Error(GENERIC_READ_ERROR);
  }

  let extracted: { text: string; trackedChanges: boolean };
  try {
    extracted = await extractDocxText(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : GENERIC_READ_ERROR;
    const detail =
      message === GENERIC_SIZE_ERROR ||
      message === GENERIC_BOMB_ERROR ||
      message === GENERIC_READ_ERROR
        ? message
        : GENERIC_READ_ERROR;
    await markFailed(ctx, documentId, detail);
    throw new Error(detail);
  }

  let body = extracted.text;
  let detail = statusDetailFor(extracted.trackedChanges);
  if (body.length > TEXT_BODY_CAP) {
    body = body.slice(0, TEXT_BODY_CAP);
    detail = `${detail}. Truncated to ${TEXT_BODY_CAP} characters.`;
  }

  const lawCase = await ctx.prisma.lawCase.findUnique({
    where: { id: doc.caseId },
    select: { spaceId: true },
  });
  if (!lawCase) throw new Error("case not found");

  const sealed = await sealLawText(
    ctx.prisma,
    {
      table: "law_documents",
      column: "body",
      rowId: documentId,
      spaceId: lawCase.spaceId,
      owner: doc.caseId,
    },
    body,
  );

  await ctx.prisma.lawDocument.update({
    where: { id: documentId },
    data: {
      body: sealed,
      status: "ready",
      statusDetail: detail,
      updatedAt: new Date(),
    },
  });

  ctx.log.info("docx imported", {
    jobId: ctx.job.id,
    documentId,
    chars: body.length,
    trackedChanges: extracted.trackedChanges,
  });
};
