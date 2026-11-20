// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { EditionTool } from "@rakazo/edition-sdk";
import { LAW_LIBRARY_KINDS } from "./cases.js";
import { openLawText } from "./seal.js";
import { searchCaseLibrary } from "./search.js";

const SEARCH_LIMIT = 10;
const BODY_PREVIEW = 4_000;
const SEGMENT_LIMIT = 40;

/** Tools case bots use to search and open this case's library. */
export async function lawCaseTools(
  prisma: PrismaClient,
  botId: string,
  actor: Pick<Actor, "userId" | "spaceId">,
): Promise<EditionTool[] | undefined> {
  const link = await prisma.lawCaseBot.findUnique({
    where: { botId },
    select: { caseId: true },
  });
  if (!link) return undefined;
  const lawCase = await prisma.lawCase.findUnique({
    where: { id: link.caseId },
    select: { id: true, spaceId: true, deletedAt: true },
  });
  if (!lawCase || lawCase.deletedAt) return undefined;

  const sessionActor: Actor = {
    userId: actor.userId,
    spaceId: actor.spaceId || lawCase.spaceId,
    email: "case-bot@local",
    isDeploymentOwner: false,
  };
  const caseId = link.caseId;
  const spaceId = lawCase.spaceId;

  return [
    {
      name: "search_case_library",
      description:
        "Search this case's library (uploads, notes, and extracted pages/segments) by keyword. Returns ranked snippets with document ids.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords to find in the case library." },
        },
        required: ["query"],
      },
      readOnly: true,
      execute: async (args) => {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (query.length < 2) return { error: "query must be at least 2 characters" };
        const result = await searchCaseLibrary(prisma, sessionActor, {
          caseId,
          query,
          limit: SEARCH_LIMIT,
        });
        if ("forbidden" in result) return { error: "Not a member of this case." };
        return {
          hits: result.hits.map((hit) => ({
            kind: hit.kind,
            documentId: hit.documentId,
            title: hit.title,
            page: hit.page,
            startMs: hit.startMs,
            snippet: hit.snippet,
            score: hit.score,
          })),
          truncated: result.truncated,
        };
      },
    },
    {
      name: "read_case_document",
      description:
        "Read a ready document from this case's library. Pass page for a PDF page; omit page for the document body or transcript segments.",
      inputSchema: {
        type: "object",
        properties: {
          documentId: {
            type: "string",
            description: "Library document id from the turn note or search.",
          },
          page: {
            type: "number",
            description: "1-based PDF page to read. Omit for the whole body or transcript.",
          },
        },
        required: ["documentId"],
      },
      readOnly: true,
      execute: async (args) => {
        const documentId = typeof args.documentId === "string" ? args.documentId.trim() : "";
        if (!documentId) return { error: "documentId is required" };
        const page =
          typeof args.page === "number" && Number.isFinite(args.page)
            ? Math.floor(args.page)
            : undefined;
        return readCaseDocument(prisma, {
          caseId,
          spaceId,
          documentId,
          page,
        });
      },
    },
  ];
}

async function readCaseDocument(
  prisma: PrismaClient,
  input: {
    caseId: string;
    spaceId: string;
    documentId: string;
    page?: number;
  },
): Promise<unknown> {
  const doc = await prisma.lawDocument.findFirst({
    where: {
      id: input.documentId,
      caseId: input.caseId,
      kind: { in: [...LAW_LIBRARY_KINDS] },
      deletedAt: null,
    },
    select: {
      id: true,
      title: true,
      filename: true,
      body: true,
      mimeType: true,
      status: true,
      pageCount: true,
    },
  });
  if (!doc) return { error: "Document not found in this case library." };
  if (doc.status !== "ready") {
    return { error: "Document is still processing.", status: doc.status };
  }

  if (input.page !== undefined) {
    if (input.page < 1) return { error: "page must be >= 1" };
    const row = await prisma.lawDocumentPage.findFirst({
      where: { documentId: doc.id, page: input.page },
      select: { id: true, page: true, text: true, ocr: true },
    });
    if (!row) return { error: `Page ${input.page} not found.`, pageCount: doc.pageCount ?? null };
    const text = await openLawText(
      prisma,
      {
        table: "law_document_pages",
        column: "text",
        rowId: row.id,
        spaceId: input.spaceId,
        owner: doc.id,
      },
      row.text,
    );
    return {
      documentId: doc.id,
      title: doc.title,
      filename: doc.filename,
      page: row.page,
      ocr: row.ocr,
      text,
      pageCount: doc.pageCount ?? null,
    };
  }

  const pageRows =
    typeof prisma.lawDocumentPage?.findMany === "function"
      ? await prisma.lawDocumentPage.findMany({
          where: { documentId: doc.id },
          select: { page: true },
          orderBy: { page: "asc" },
        })
      : [];
  if (pageRows.length > 0) {
    const body = await openLawText(
      prisma,
      {
        table: "law_documents",
        column: "body",
        rowId: doc.id,
        spaceId: input.spaceId,
        owner: input.caseId,
      },
      doc.body,
    );
    return {
      documentId: doc.id,
      title: doc.title,
      filename: doc.filename,
      mimeType: doc.mimeType,
      pageCount: doc.pageCount ?? pageRows.length,
      pages: pageRows.map((row) => row.page),
      text: body.slice(0, BODY_PREVIEW),
      truncated: body.length > BODY_PREVIEW,
      hint: "Pass page to read_case_document for one page's full text.",
    };
  }

  const segments =
    typeof prisma.lawTranscriptSegment?.findMany === "function"
      ? await prisma.lawTranscriptSegment.findMany({
          where: { documentId: doc.id },
          select: { id: true, idx: true, startMs: true, endMs: true, speaker: true, text: true },
          orderBy: { idx: "asc" },
          take: SEGMENT_LIMIT,
        })
      : [];
  if (segments.length > 0) {
    const opened = await Promise.all(
      segments.map(async (row) => ({
        idx: row.idx,
        startMs: row.startMs,
        endMs: row.endMs,
        speaker: row.speaker,
        text: await openLawText(
          prisma,
          {
            table: "law_transcript_segments",
            column: "text",
            rowId: row.id,
            spaceId: input.spaceId,
            owner: doc.id,
          },
          row.text,
        ),
      })),
    );
    return {
      documentId: doc.id,
      title: doc.title,
      filename: doc.filename,
      mimeType: doc.mimeType,
      segments: opened,
      truncated: opened.length >= SEGMENT_LIMIT,
    };
  }

  const body = await openLawText(
    prisma,
    {
      table: "law_documents",
      column: "body",
      rowId: doc.id,
      spaceId: input.spaceId,
      owner: input.caseId,
    },
    doc.body,
  );
  return {
    documentId: doc.id,
    title: doc.title,
    filename: doc.filename,
    mimeType: doc.mimeType,
    text: body.slice(0, BODY_PREVIEW),
    truncated: body.length > BODY_PREVIEW,
  };
}
