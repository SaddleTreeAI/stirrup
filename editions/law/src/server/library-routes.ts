// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsTenant, tryRecordAuditEvent } from "@rakazo/db";
import type { EditionFiles, EditionRouteDeps } from "@rakazo/edition-sdk";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import { lawDocumentFilename } from "./cases.js";
import { sanitizeFilename, uploadLibraryDocument } from "./library-upload.js";
import type { TranscriptSegment } from "./media/segments.js";
import { formatSrt, formatTranscriptBody, formatVtt } from "./media/segments.js";
import { openLawText, sealLawText } from "./seal.js";

const SEGMENTS_PAGE_MAX = 500;

const TITLE_MAX = 200;

type LibraryDeps = EditionRouteDeps;

/** Upload, create, rename, delete, and download routes for a case library. */
export function mountLibraryRoutes(app: Hono, deps: LibraryDeps) {
  app.post("/api/law/cases/:id/documents/upload", async (c) => {
    try {
      const actor = await deps.sessionActor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const files = requireFiles(deps.files);
      if (!files) return c.json({ error: "Upload unavailable" }, 503);

      const contentLength = Number(c.req.header("content-length"));
      if (Number.isFinite(contentLength) && contentLength > files.maxBytes) {
        return c.json({ error: "File too large" }, 413);
      }

      const caseId = c.req.param("id");
      const form = await c.req.formData();
      const fileEntry = form.get("file");
      if (!(fileEntry instanceof File)) return c.json({ error: "File required" }, 400);
      const optionalTitle = form.get("title");
      const titleOverride =
        typeof optionalTitle === "string" && optionalTitle.trim()
          ? optionalTitle.trim()
          : undefined;

      const filename = sanitizeFilename(fileEntry.name || "upload");
      const mediaType = fileEntry.type || "application/octet-stream";
      if (fileEntry.size > files.maxBytes) return c.json({ error: "File too large" }, 413);

      const bytes = new Uint8Array(await fileEntry.arrayBuffer());
      if (bytes.byteLength > files.maxBytes) return c.json({ error: "File too large" }, 413);

      const result = await runAsTenant(actor, () =>
        uploadLibraryDocument(deps.prisma, files, actor, {
          caseId,
          filename,
          mediaType,
          bytes,
          titleOverride,
        }),
      );
      if (result === "forbidden") return c.json({ error: "Not found" }, 404);
      if (result && "conflict" in result) {
        return c.json({ error: "Duplicate content", existingId: result.existingId }, 409);
      }
      if (!result) return c.json({ error: "Couldn't upload" }, 500);
      return c.json({ document: serializeDocument(result) }, 201);
    } catch (error) {
      getLogger().error("library upload", error);
      return c.json({ error: "Couldn't upload" }, 500);
    }
  });

  app.post("/api/law/cases/:id/documents", async (c) => {
    try {
      const actor = await deps.sessionActor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const caseId = c.req.param("id");
      const body = (await c.req.json().catch(() => null)) as {
        title?: unknown;
        body?: unknown;
      } | null;
      const title = typeof body?.title === "string" ? body.title.trim() : "";
      if (!title || title.length > TITLE_MAX) return c.json({ error: "Invalid title" }, 400);
      const text = typeof body?.body === "string" ? body.body : "";
      const created = await runAsTenant(actor, () =>
        createNoteDocument(deps.prisma, actor, { caseId, title, body: text }),
      );
      if (!created) return c.json({ error: "Not found" }, 404);
      return c.json({ document: serializeDocument(created) }, 201);
    } catch (error) {
      getLogger().error("library create note", error);
      return c.json({ error: "Couldn't create document" }, 500);
    }
  });

  app.patch("/api/law/cases/:id/documents/:docId", async (c) => {
    try {
      const actor = await deps.sessionActor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const caseId = c.req.param("id");
      const docId = c.req.param("docId");
      const body = (await c.req.json().catch(() => null)) as { title?: unknown } | null;
      const title = typeof body?.title === "string" ? body.title.trim() : "";
      if (!title || title.length > TITLE_MAX) return c.json({ error: "Invalid title" }, 400);
      const updated = await runAsTenant(actor, () =>
        renameDocumentFamily(deps.prisma, actor.userId, { caseId, docId, title }),
      );
      if (!updated) return c.json({ error: "Not found" }, 404);
      return c.json({ document: serializeDocument(updated) }, 200);
    } catch (error) {
      getLogger().error("library rename", error);
      return c.json({ error: "Couldn't rename" }, 500);
    }
  });

  app.delete("/api/law/cases/:id/documents/:docId", async (c) => {
    try {
      const actor = await deps.sessionActor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const caseId = c.req.param("id");
      const docId = c.req.param("docId");
      const deleted = await runAsTenant(actor, () =>
        softDeleteDocumentFamily(deps.prisma, actor, { caseId, docId }),
      );
      if (!deleted) return c.json({ error: "Not found" }, 404);
      return c.body(null, 204);
    } catch (error) {
      getLogger().error("library delete", error);
      return c.json({ error: "Couldn't delete" }, 500);
    }
  });

  app.get("/api/law/cases/:id/documents/:docId/file", async (c) => {
    try {
      const actor = await deps.sessionActor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const files = requireFiles(deps.files);
      if (!files) return c.json({ error: "Download unavailable" }, 503);
      const caseId = c.req.param("id");
      const docId = c.req.param("docId");
      const inline = c.req.query("inline") === "1";
      const variant = c.req.query("variant") === "searchable" ? "searchable" : "original";

      const opened = await runAsTenant(actor, () =>
        openDocumentFile(deps.prisma, files, actor, { caseId, docId, variant }),
      );
      if (!opened) return c.json({ error: "Not found" }, 404);

      const disposition = contentDisposition(opened.filename, opened.mimeType, inline);
      const contentType = safeContentType(opened.mimeType);
      const size = opened.size;
      const baseHeaders: Record<string, string> = {
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        "content-disposition": disposition,
        "content-type": contentType,
        "x-content-type-options": "nosniff",
      };

      const rangeHeader = c.req.header("range");
      const range = parseBytesRange(rangeHeader, size);
      if (range === "unsatisfiable") {
        await opened.stream.cancel().catch(() => undefined);
        return new Response(null, {
          status: 416,
          headers: {
            ...baseHeaders,
            "content-range": `bytes */${size}`,
          },
        });
      }
      if (range) {
        // Skip-to-offset by reading the stream: fine for local disk; for object
        // storage this discards prefix bytes per seek (prefer ranged GETs later).
        const body = sliceByteStream(opened.stream, range.start, range.end);
        const length = range.end - range.start + 1;
        return new Response(body, {
          status: 206,
          headers: {
            ...baseHeaders,
            "content-length": String(length),
            "content-range": `bytes ${range.start}-${range.end}/${size}`,
          },
        });
      }

      return new Response(opened.stream, {
        headers: {
          ...baseHeaders,
          "content-length": String(size),
        },
      });
    } catch (error) {
      getLogger().error("library download", error);
      return c.json({ error: "Couldn't download" }, 500);
    }
  });

  app.get("/api/law/cases/:id/documents/:docId/pages", async (c) => {
    try {
      const actor = await deps.sessionActor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const caseId = c.req.param("id");
      const docId = c.req.param("docId");
      const from = parsePageBound(c.req.query("from"), 1);
      const to = parsePageBound(c.req.query("to"), from);
      if (to < from || to - from + 1 > 20) {
        return c.json({ error: "Invalid page range" }, 400);
      }
      const pages = await runAsTenant(actor, () =>
        listDocumentPages(deps.prisma, actor, { caseId, docId, from, to }),
      );
      if (!pages) return c.json({ error: "Not found" }, 404);
      return c.json({ pages });
    } catch (error) {
      getLogger().error("library pages", error);
      return c.json({ error: "Couldn't load pages" }, 500);
    }
  });

  app.get("/api/law/cases/:id/documents/:docId/transcript", async (c) => {
    try {
      const actor = await deps.sessionActor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const caseId = c.req.param("id");
      const docId = c.req.param("docId");
      const format = (c.req.query("format") || "txt").toLowerCase();
      if (format !== "txt" && format !== "srt" && format !== "vtt") {
        return c.json({ error: "Invalid format" }, 400);
      }

      const result = await runAsTenant(actor, () =>
        exportTranscript(deps.prisma, actor, { caseId, docId, format }),
      );
      if (!result) return c.json({ error: "Not found" }, 404);

      return new Response(result.body, {
        headers: {
          "cache-control": "no-store",
          "content-disposition": contentDisposition(result.filename, result.mimeType, false),
          "content-type": `${result.mimeType}; charset=utf-8`,
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      getLogger().error("library transcript export", error);
      return c.json({ error: "Couldn't export" }, 500);
    }
  });

  app.get("/api/law/cases/:id/documents/:docId/segments", async (c) => {
    try {
      const actor = await deps.sessionActor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const caseId = c.req.param("id");
      const docId = c.req.param("docId");
      const fromRaw = c.req.query("from");
      const toRaw = c.req.query("to");
      const fromMs = fromRaw !== undefined && fromRaw !== "" ? Number(fromRaw) : 0;
      const toMs = toRaw !== undefined && toRaw !== "" ? Number(toRaw) : Number.MAX_SAFE_INTEGER;
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs < 0 || toMs < fromMs) {
        return c.json({ error: "Invalid range" }, 400);
      }

      const result = await runAsTenant(actor, () =>
        listTranscriptSegments(deps.prisma, actor, {
          caseId,
          docId,
          fromMs,
          toMs,
          limit: SEGMENTS_PAGE_MAX,
        }),
      );
      if (!result) return c.json({ error: "Not found" }, 404);
      return c.json(result);
    } catch (error) {
      getLogger().error("library segments", error);
      return c.json({ error: "Couldn't list segments" }, 500);
    }
  });
}

function requireFiles(files: EditionFiles | undefined): EditionFiles | null {
  return files ?? null;
}

async function requireMember(
  prisma: PrismaClient,
  userId: string,
  caseId: string,
): Promise<boolean> {
  const member = await prisma.lawCaseMember.findUnique({
    where: { caseId_userId: { caseId, userId } },
    select: { userId: true },
  });
  if (!member) return false;
  const lawCase = await prisma.lawCase.findUnique({
    where: { id: caseId },
    select: { deletedAt: true },
  });
  return Boolean(lawCase && !lawCase.deletedAt);
}

async function createNoteDocument(
  prisma: PrismaClient,
  actor: Actor,
  input: { caseId: string; title: string; body: string },
) {
  if (!(await requireMember(prisma, actor.userId, input.caseId))) return null;
  const filename = `${slugify(input.title) || "note"}.md`;
  const id = randomUUID();
  const body = await sealLawText(
    prisma,
    {
      table: "law_documents",
      column: "body",
      rowId: id,
      spaceId: actor.spaceId,
      owner: input.caseId,
    },
    input.body,
  );
  const created = await prisma.lawDocument.create({
    data: {
      id,
      caseId: input.caseId,
      title: input.title,
      filename,
      body,
      kind: "note",
      version: 1,
      source: "edit",
      mimeType: "text/markdown",
      sizeBytes: Buffer.byteLength(input.body, "utf8"),
      status: "ready",
      statusDetail: "",
      uploadedBy: actor.userId,
      updatedAt: new Date(),
    },
  });
  return { ...created, body: input.body };
}

async function renameDocumentFamily(
  prisma: PrismaClient,
  userId: string,
  input: { caseId: string; docId: string; title: string },
) {
  if (!(await requireMember(prisma, userId, input.caseId))) return null;
  const current = await prisma.lawDocument.findFirst({
    where: { id: input.docId, caseId: input.caseId, deletedAt: null },
    select: { id: true, title: true, filename: true, rootId: true },
  });
  if (!current) return null;
  const rootId = current.rootId ?? current.id;
  const family = await prisma.lawDocument.findMany({
    where: {
      caseId: input.caseId,
      deletedAt: null,
      OR: [{ id: rootId }, { rootId }],
    },
    select: { id: true, filename: true },
  });
  const now = new Date();
  for (const row of family) {
    await prisma.lawDocument.update({
      where: { id: row.id },
      data: {
        title: input.title,
        filename: renameFilename(row.filename, input.title),
        updatedAt: now,
      },
    });
  }
  const updated = await prisma.lawDocument.findFirst({
    where: { id: input.docId, caseId: input.caseId },
  });
  if (!updated) return null;
  const lawCase = await prisma.lawCase.findUnique({
    where: { id: input.caseId },
    select: { spaceId: true },
  });
  if (!lawCase) return updated;
  return {
    ...updated,
    body: await openLawText(
      prisma,
      {
        table: "law_documents",
        column: "body",
        rowId: updated.id,
        spaceId: lawCase.spaceId,
        owner: input.caseId,
      },
      updated.body,
    ),
  };
}

async function softDeleteDocumentFamily(
  prisma: PrismaClient,
  actor: Actor,
  input: { caseId: string; docId: string },
) {
  if (!(await requireMember(prisma, actor.userId, input.caseId))) return false;
  const current = await prisma.lawDocument.findFirst({
    where: { id: input.docId, caseId: input.caseId, deletedAt: null },
    select: { id: true, rootId: true },
  });
  if (!current) return false;
  const rootId = current.rootId ?? current.id;
  const family = await prisma.lawDocument.findMany({
    where: {
      caseId: input.caseId,
      deletedAt: null,
      OR: [{ id: rootId }, { rootId }],
    },
    select: { id: true },
  });
  const ids = family.map((row) => row.id);
  const now = new Date();
  await prisma.lawDocument.updateMany({
    where: { id: { in: ids } },
    data: { deletedAt: now, updatedAt: now },
  });
  await prisma.lawDocumentPage.deleteMany({ where: { documentId: { in: ids } } });
  await prisma.lawJob.updateMany({
    where: { caseId: input.caseId, documentId: { in: ids }, status: "queued" },
    data: { status: "cancelled", updatedAt: now },
  });
  try {
    await tryRecordAuditEvent({
      action: "document.deleted",
      actor: { type: "user", id: actor.userId },
      spaceId: actor.spaceId,
      userId: actor.userId,
      target: { type: "document", id: input.docId },
      metadata: { caseId: input.caseId, familySize: ids.length },
    });
  } catch (error) {
    getLogger().error("library delete audit", error);
  }
  return true;
}

async function openDocumentFile(
  prisma: PrismaClient,
  files: EditionFiles,
  actor: Actor,
  input: { caseId: string; docId: string; variant?: "original" | "searchable" },
) {
  if (!(await requireMember(prisma, actor.userId, input.caseId))) return null;
  const doc = await prisma.lawDocument.findFirst({
    where: { id: input.docId, caseId: input.caseId, deletedAt: null },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      artifactId: true,
      derivedArtifactId: true,
    },
  });
  if (!doc) return null;
  const searchable = input.variant === "searchable";
  const artifactId = searchable ? doc.derivedArtifactId : doc.artifactId;
  if (!artifactId) return null;
  const opened = await files.open({ spaceId: actor.spaceId, artifactId });
  if (!opened) return null;
  const filename = searchable
    ? searchableFilename(doc.filename || "download")
    : doc.filename || "download";
  return {
    stream: opened.stream,
    size: opened.size,
    mimeType: searchable ? "application/pdf" : doc.mimeType || opened.mediaType,
    filename,
  };
}

function searchableFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "") || "document";
  return `${base}-searchable.pdf`;
}

async function listDocumentPages(
  prisma: PrismaClient,
  actor: Actor,
  input: { caseId: string; docId: string; from: number; to: number },
) {
  if (!(await requireMember(prisma, actor.userId, input.caseId))) return null;
  const doc = await prisma.lawDocument.findFirst({
    where: { id: input.docId, caseId: input.caseId, deletedAt: null },
    select: { id: true },
  });
  if (!doc) return null;
  const lawCase = await prisma.lawCase.findUnique({
    where: { id: input.caseId },
    select: { spaceId: true },
  });
  if (!lawCase) return null;
  const rows = await prisma.lawDocumentPage.findMany({
    where: {
      documentId: input.docId,
      page: { gte: input.from, lte: input.to },
    },
    select: { id: true, page: true, text: true, ocr: true },
    orderBy: { page: "asc" },
  });
  return Promise.all(
    rows.map(async (row) => ({
      page: row.page,
      ocr: row.ocr,
      text: await openLawText(
        prisma,
        {
          table: "law_document_pages",
          column: "text",
          rowId: row.id,
          spaceId: lawCase.spaceId,
          owner: input.docId,
        },
        row.text,
      ),
    })),
  );
}

function parsePageBound(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

type OpenedSegment = TranscriptSegment & { idx: number };

async function loadOpenedSegments(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    caseId: string;
    docId: string;
    fromMs?: number;
    toMs?: number;
    /** When set, caps the page (segments API). Omit for full transcript export. */
    limit?: number;
  },
): Promise<{ docFilename: string; segments: OpenedSegment[] } | null> {
  if (!(await requireMember(prisma, actor.userId, input.caseId))) return null;
  const doc = await prisma.lawDocument.findFirst({
    where: { id: input.docId, caseId: input.caseId, deletedAt: null },
    select: { id: true, filename: true },
  });
  if (!doc) return null;

  const fromMs = input.fromMs ?? 0;
  const toMs = input.toMs ?? Number.MAX_SAFE_INTEGER;
  const take = input.limit !== undefined ? Math.min(input.limit, SEGMENTS_PAGE_MAX) : undefined;

  const rows = await prisma.lawTranscriptSegment.findMany({
    where: {
      documentId: input.docId,
      startMs: { lte: toMs },
      endMs: { gte: fromMs },
    },
    orderBy: { idx: "asc" },
    ...(take !== undefined ? { take } : {}),
  });

  const segments: OpenedSegment[] = [];
  for (const row of rows) {
    const text = await openLawText(
      prisma,
      {
        table: "law_transcript_segments",
        column: "text",
        rowId: row.id,
        spaceId: actor.spaceId,
        owner: input.docId,
      },
      row.text,
    );
    segments.push({
      idx: row.idx,
      startMs: row.startMs,
      endMs: row.endMs,
      text,
      speaker: row.speaker,
    });
  }
  return { docFilename: doc.filename || "transcript", segments };
}

async function exportTranscript(
  prisma: PrismaClient,
  actor: Actor,
  input: { caseId: string; docId: string; format: "txt" | "srt" | "vtt" },
) {
  const loaded = await loadOpenedSegments(prisma, actor, {
    caseId: input.caseId,
    docId: input.docId,
  });
  if (!loaded) return null;

  const stem = loaded.docFilename.replace(/\.[^.]+$/, "") || "transcript";
  if (input.format === "srt") {
    return {
      body: formatSrt(loaded.segments),
      filename: `${stem}.srt`,
      mimeType: "application/x-subrip",
    };
  }
  if (input.format === "vtt") {
    return {
      body: formatVtt(loaded.segments),
      filename: `${stem}.vtt`,
      mimeType: "text/vtt",
    };
  }
  return {
    body: formatTranscriptBody(loaded.segments),
    filename: `${stem}.txt`,
    mimeType: "text/plain",
  };
}

async function listTranscriptSegments(
  prisma: PrismaClient,
  actor: Actor,
  input: { caseId: string; docId: string; fromMs: number; toMs: number; limit: number },
) {
  const loaded = await loadOpenedSegments(prisma, actor, input);
  if (!loaded) return null;
  return {
    segments: loaded.segments.map((s) => ({
      idx: s.idx,
      startMs: s.startMs,
      endMs: s.endMs,
      speaker: s.speaker ?? null,
      text: s.text,
    })),
    limit: input.limit,
  };
}

export type ListedDocument = {
  id: string;
  title: string;
  filename: string;
  kind: string;
  body: string;
  version: number;
  rootId: string;
  createdAt: string;
  source: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  statusDetail: string;
  pageCount: number | null;
  durationMs: number | null;
  hasOriginal: boolean;
  hasSearchable: boolean;
};

export function serializeDocument(doc: {
  id: string;
  title: string;
  filename: string;
  kind: string;
  body: string;
  version: number;
  rootId: string | null;
  createdAt: Date;
  source?: string;
  mimeType?: string;
  sizeBytes?: number;
  status?: string;
  statusDetail?: string;
  pageCount?: number | null;
  durationMs?: number | null;
  artifactId?: string | null;
  derivedArtifactId?: string | null;
}): ListedDocument {
  return {
    id: doc.id,
    title: doc.title,
    filename: doc.filename || lawDocumentFilename(doc.title, doc.kind),
    kind: doc.kind,
    body: doc.body,
    version: doc.version,
    rootId: doc.rootId ?? doc.id,
    createdAt: doc.createdAt.toISOString(),
    source: doc.source ?? "bot",
    mimeType: doc.mimeType ?? "",
    sizeBytes: doc.sizeBytes ?? 0,
    status: doc.status ?? "ready",
    statusDetail: doc.statusDetail ?? "",
    pageCount: doc.pageCount ?? null,
    durationMs: doc.durationMs ?? null,
    hasOriginal: Boolean(doc.artifactId),
    hasSearchable: Boolean(doc.derivedArtifactId),
  };
}

export { sanitizeFilename } from "./library-upload.js";

function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function renameFilename(existing: string, title: string): string {
  const lastDot = existing.lastIndexOf(".");
  const ext = lastDot > 0 ? existing.slice(lastDot) : "";
  const stem = slugify(title) || "document";
  return `${stem}${ext}`;
}

function contentDisposition(filename: string, mimeType: string, inlineRequested: boolean): string {
  const safeName = sanitizeFilename(filename).replace(/["\\]/g, "_").slice(0, 180) || "download";
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const useInline = inlineRequested && allowsInline(mimeType);
  const kind = useInline ? "inline" : "attachment";
  return `${kind}; filename="${safeName}"; filename*=UTF-8''${encoded}`;
}

function allowsInline(mimeType: string): boolean {
  const mime = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mime === "application/pdf") return true;
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return true;
  return false;
}

function safeContentType(value: string): string {
  const mediaType = value.split(";", 1)[0]?.trim() ?? "";
  return /^[\w.+-]+\/[\w.+-]+$/.test(mediaType) ? mediaType : "application/octet-stream";
}

/** Parse a single `bytes=` Range. Malformed headers are ignored (full body). */
export function parseBytesRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  if (startRaw === "" && endRaw === "") return null;

  if (startRaw === "") {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    if (size === 0) return "unsatisfiable";
    const length = Math.min(Math.floor(suffix), size);
    return { start: size - length, end: size - 1 };
  }

  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0 || !Number.isInteger(start)) return null;
  if (start >= size) return "unsatisfiable";

  if (endRaw === "") {
    return { start, end: size - 1 };
  }
  const end = Number(endRaw);
  if (!Number.isFinite(end) || end < 0 || !Number.isInteger(end)) return null;
  return { start, end: Math.min(end, size - 1) };
}

/** Emit only `[start, end]` inclusive from `source`, cancelling the rest. */
export function sliceByteStream(
  source: ReadableStream<Uint8Array>,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  const length = Math.max(0, end - start + 1);
  const reader = source.getReader();
  let skipped = 0;
  let emitted = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (emitted < length) {
        const { done, value } = await reader.read();
        if (done || !value) {
          controller.close();
          return;
        }
        let chunk = value;
        if (skipped < start) {
          const need = start - skipped;
          if (chunk.length <= need) {
            skipped += chunk.length;
            continue;
          }
          chunk = chunk.subarray(need);
          skipped = start;
        }
        const remain = length - emitted;
        if (chunk.length > remain) {
          controller.enqueue(chunk.subarray(0, remain));
          emitted = length;
          await reader.cancel().catch(() => undefined);
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        emitted += chunk.length;
      }
      controller.close();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
