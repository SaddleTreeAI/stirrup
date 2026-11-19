// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { PrismaClient } from "@rakazo/db";

export type IngestKind = "text" | "pdf" | "docx" | "audio" | "video" | "image" | "other";

export type Classification = { kind: IngestKind; textual: boolean };

const TEXT_BODY_CAP = 2_000_000;

const TEXTUAL_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "json", "html", "htm"]);
const TEXTUAL_MIME = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/json",
  "application/xhtml+xml",
]);

/** Classify an upload by media type and filename for library ingest. */
export function classify(mediaType: string, filename: string): Classification {
  const mime = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const ext = extensionOf(filename);

  if (ext === "rtf" || mime === "application/rtf" || mime === "text/rtf") {
    return { kind: "other", textual: false };
  }
  if (TEXTUAL_EXTENSIONS.has(ext) || TEXTUAL_MIME.has(mime) || mime.startsWith("text/")) {
    return { kind: "text", textual: true };
  }
  if (mime === "application/pdf" || ext === "pdf") {
    return { kind: "pdf", textual: false };
  }
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    return { kind: "docx", textual: false };
  }
  if (mime.startsWith("audio/") || ["mp3", "wav", "m4a", "ogg", "flac", "aac"].includes(ext)) {
    return { kind: "audio", textual: false };
  }
  if (mime.startsWith("video/") || ["mp4", "webm", "mov", "mkv"].includes(ext)) {
    return { kind: "video", textual: false };
  }
  if (
    mime.startsWith("image/") ||
    ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif"].includes(ext)
  ) {
    return { kind: "image", textual: false };
  }
  return { kind: "other", textual: false };
}

export type TextIngestResult = {
  body: string;
  status: "ready";
  statusDetail: string;
};

/** Decode textual bytes (UTF-8, strip BOM, cap) or leave a non-text placeholder. */
export function prepareIngestBody(
  classification: Classification,
  bytes: Uint8Array,
  mediaType: string,
  filename: string,
): TextIngestResult {
  if (!classification.textual) {
    return {
      body: "",
      status: "ready",
      statusDetail: "Stored. Text extraction not available for this file type yet.",
    };
  }
  let text = new TextDecoder("utf-8").decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (isHtml(mediaType, filename)) text = stripHtml(text);
  if (text.length > TEXT_BODY_CAP) {
    return {
      body: text.slice(0, TEXT_BODY_CAP),
      status: "ready",
      statusDetail: `Truncated to ${TEXT_BODY_CAP} characters.`,
    };
  }
  return { body: text, status: "ready", statusDetail: "" };
}

/**
 * Queue extraction for kinds that need it later (P1 / DOC1 / V1).
 * Today every kind returns null — nothing is enqueued.
 */
export async function enqueueExtraction(
  _prisma: Pick<PrismaClient, "lawJob">,
  _doc: { id: string; caseId: string; kind?: string },
): Promise<null> {
  return null;
}

function extensionOf(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function isHtml(mediaType: string, filename: string): boolean {
  const mime = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const ext = extensionOf(filename);
  return (
    mime === "text/html" || mime === "application/xhtml+xml" || ext === "html" || ext === "htm"
  );
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
