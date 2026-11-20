// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsTenant } from "@rakazo/db";
import type { EditionRouteDeps } from "@rakazo/edition-sdk";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import { openLawText } from "./seal.js";

const BATCH = 500;
const DEFAULT_MAX_ROWS = 20_000;
const DEFAULT_LIMIT = 50;
const LIMIT_MAX = 50;
const QUERY_MIN = 2;
const QUERY_MAX = 200;
const SNIPPET_RADIUS = 100;
const SNIPPET_MAX = 200;

const PHRASE_BONUS = 8;
const ALL_TERMS_BONUS = 4;
const TITLE_BONUS = 6;
const TERM_WEIGHT = 2;

export type SearchHitKind = "text" | "page" | "segment" | "frame";

export type SearchMatch = { start: number; end: number };

export type SearchHit = {
  kind: SearchHitKind;
  documentId: string;
  title: string;
  page?: number;
  startMs?: number;
  snippet: string;
  matches: SearchMatch[];
  score: number;
};

export type ScoredText = {
  score: number;
  snippet: string;
  matches: SearchMatch[];
};

export type SearchableRow = {
  kind: SearchHitKind;
  documentId: string;
  title: string;
  text: string;
  page?: number;
  startMs?: number;
  /** Milliseconds since epoch; newer wins ties. */
  createdAtMs: number;
};

/** Fold case and strip diacritics for matching. */
export function foldSearchText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function searchTerms(query: string): string[] {
  const folded = foldSearchText(query.trim());
  if (!folded) return [];
  const parts = folded.split(/[^a-z0-9]+/).filter((part) => part.length > 0);
  return [...new Set(parts)];
}

/**
 * Pure scorer: phrase bonus, all-terms bonus, term frequency with length
 * normalization, title bonus. Returns null when nothing matches.
 */
export function scoreSearchRow(query: string, title: string, text: string): ScoredText | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const terms = searchTerms(trimmed);
  const phrase = foldSearchText(trimmed);
  if (!phrase && terms.length === 0) return null;

  const foldedTitle = foldSearchText(title);
  const foldedText = foldSearchText(text);
  const haystack = `${foldedTitle}\n${foldedText}`;

  let score = 0;
  let matched = false;

  if (phrase.length >= 2 && haystack.includes(phrase)) {
    score += PHRASE_BONUS;
    matched = true;
  }

  let termHits = 0;
  let termCount = 0;
  for (const term of terms) {
    const inTitle = countOccurrences(foldedTitle, term);
    const inBody = countOccurrences(foldedText, term);
    const total = inTitle + inBody;
    if (total > 0) {
      termHits += 1;
      termCount += total;
      matched = true;
    }
  }
  if (terms.length > 0 && termHits === terms.length) score += ALL_TERMS_BONUS;
  if (termCount > 0) {
    const lengthNorm = Math.sqrt(Math.max(1, foldedText.length + foldedTitle.length));
    score += (TERM_WEIGHT * termCount) / lengthNorm;
  }

  for (const term of terms) {
    if (foldedTitle.includes(term)) {
      score += TITLE_BONUS;
      matched = true;
      break;
    }
  }
  if (phrase.length >= 2 && foldedTitle.includes(phrase)) {
    score += TITLE_BONUS / 2;
    matched = true;
  }

  if (!matched) return null;

  const snippetBuilt = buildSnippet(text, trimmed, terms);
  return { score, snippet: snippetBuilt.snippet, matches: snippetBuilt.matches };
}

type RankedHit = SearchHit & { createdAtMs: number };

/** Score one row; push a hit (snippet + ids only) when it matches. */
export function collectHitIfMatch(query: string, row: SearchableRow, hits: RankedHit[]): void {
  const result = scoreSearchRow(query, row.title, row.text);
  if (!result) return;
  hits.push({
    kind: row.kind,
    documentId: row.documentId,
    title: row.title,
    page: row.page,
    startMs: row.startMs,
    snippet: result.snippet,
    matches: result.matches,
    score: result.score,
    createdAtMs: row.createdAtMs,
  });
}

export function sortRankedHits(hits: RankedHit[]): SearchHit[] {
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.createdAtMs !== a.createdAtMs) return b.createdAtMs - a.createdAtMs;
    return a.documentId.localeCompare(b.documentId) || a.kind.localeCompare(b.kind);
  });
  return hits.map(({ createdAtMs: _createdAtMs, ...hit }) => hit);
}

export function rankSearchHits(query: string, rows: readonly SearchableRow[]): SearchHit[] {
  const scored: RankedHit[] = [];
  for (const row of rows) collectHitIfMatch(query, row, scored);
  return sortRankedHits(scored);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

function buildSnippet(
  text: string,
  query: string,
  terms: readonly string[],
): { snippet: string; matches: SearchMatch[] } {
  const foldedText = foldSearchText(text);
  const phrase = foldSearchText(query.trim());
  let at = -1;
  let matchLen = 0;
  if (phrase.length >= 2) {
    at = foldedText.indexOf(phrase);
    if (at >= 0) matchLen = phrase.length;
  }
  if (at < 0) {
    for (const term of terms) {
      const found = foldedText.indexOf(term);
      if (found >= 0 && (at < 0 || found < at)) {
        at = found;
        matchLen = term.length;
      }
    }
  }
  if (at < 0) {
    const snippet = text.slice(0, SNIPPET_MAX);
    return { snippet, matches: [] };
  }

  // Map folded index back approximately by walking original with fold lengths.
  const originalStart = mapFoldedIndex(text, at);
  const originalEnd = mapFoldedIndex(text, at + matchLen);
  const start = Math.max(0, originalStart - SNIPPET_RADIUS);
  let end = Math.min(text.length, originalEnd + SNIPPET_RADIUS);
  if (end - start > SNIPPET_MAX) end = start + SNIPPET_MAX;
  const snippet = text.slice(start, end);
  const matchStart = Math.max(0, originalStart - start);
  const matchEnd = Math.min(snippet.length, originalEnd - start);
  const matches: SearchMatch[] =
    matchEnd > matchStart ? [{ start: matchStart, end: matchEnd }] : [];
  return { snippet, matches };
}

/** Advance through `text` until the folded length reaches `target`. */
function mapFoldedIndex(text: string, target: number): number {
  let folded = 0;
  for (let i = 0; i < text.length; i++) {
    if (folded >= target) return i;
    const ch = text[i]!;
    const foldedCh = foldSearchText(ch);
    folded += foldedCh.length;
  }
  return text.length;
}

export function lawSearchMaxRows(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LAW_SEARCH_MAX_ROWS;
  if (!raw) return DEFAULT_MAX_ROWS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_ROWS;
  return Math.floor(n);
}

/** Simple in-memory token bucket: 30 searches per minute per user. */
const buckets = new Map<string, { tokens: number; updatedAt: number }>();
const BUCKET_CAPACITY = 30;
const BUCKET_REFILL_MS = 60_000;

export function resetSearchRateLimitForTests(): void {
  buckets.clear();
}

export function allowSearch(userId: string, now = Date.now()): boolean {
  const current = buckets.get(userId);
  if (!current) {
    buckets.set(userId, { tokens: BUCKET_CAPACITY - 1, updatedAt: now });
    return true;
  }
  const elapsed = now - current.updatedAt;
  const refill = Math.floor((elapsed / BUCKET_REFILL_MS) * BUCKET_CAPACITY);
  const tokens = Math.min(BUCKET_CAPACITY, current.tokens + Math.max(0, refill));
  if (tokens < 1) {
    buckets.set(userId, { tokens, updatedAt: refill > 0 ? now : current.updatedAt });
    return false;
  }
  buckets.set(userId, {
    tokens: tokens - 1,
    updatedAt: refill > 0 ? now : current.updatedAt,
  });
  return true;
}

export async function searchCaseLibrary(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    caseId: string;
    query: string;
    limit?: number;
    cursor?: string | null;
    maxRows?: number;
  },
): Promise<
  | { forbidden: true }
  | {
      hits: SearchHit[];
      truncated: boolean;
      nextCursor: string | null;
      scanned: number;
      durationMs: number;
    }
> {
  const started = Date.now();
  if (!(await requireMember(prisma, actor.userId, input.caseId))) {
    return { forbidden: true };
  }

  const lawCase = await prisma.lawCase.findUnique({
    where: { id: input.caseId },
    select: { spaceId: true, deletedAt: true },
  });
  if (!lawCase || lawCase.deletedAt) return { forbidden: true };

  const maxRows = input.maxRows ?? lawSearchMaxRows();
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), LIMIT_MAX);
  const offset = parseCursor(input.cursor);

  // Keep only scored hits (snippet + ids), not decrypted bodies.
  const hitsAcc: RankedHit[] = [];
  let scanned = 0;
  let truncated = false;

  // Scalar models only — resolve ready docs first (ids/titles), then stream bodies.
  const readyMeta = await prisma.lawDocument.findMany({
    where: { caseId: input.caseId, deletedAt: null, status: "ready" },
    orderBy: { id: "asc" },
    select: { id: true, title: true, createdAt: true },
  });
  const docMeta = new Map<string, { title: string; createdAtMs: number }>();
  const readyIds: string[] = [];
  for (const doc of readyMeta) {
    readyIds.push(doc.id);
    docMeta.set(doc.id, { title: doc.title, createdAtMs: doc.createdAt.getTime() });
  }

  let docCursor: string | undefined;
  while (scanned < maxRows) {
    const take = Math.min(BATCH, maxRows - scanned);
    const docs = await prisma.lawDocument.findMany({
      where: {
        caseId: input.caseId,
        deletedAt: null,
        status: "ready",
        ...(docCursor ? { id: { gt: docCursor } } : {}),
      },
      orderBy: { id: "asc" },
      take,
      select: { id: true, title: true, body: true, createdAt: true },
    });
    if (docs.length === 0) break;
    for (const doc of docs) {
      scanned += 1;
      const body = await openLawText(
        prisma,
        {
          table: "law_documents",
          column: "body",
          rowId: doc.id,
          spaceId: lawCase.spaceId,
          owner: input.caseId,
        },
        doc.body,
      );
      collectHitIfMatch(
        input.query,
        {
          kind: "text",
          documentId: doc.id,
          title: doc.title,
          text: body,
          createdAtMs: doc.createdAt.getTime(),
        },
        hitsAcc,
      );
      docCursor = doc.id;
      if (scanned >= maxRows) {
        truncated = true;
        break;
      }
    }
    if (docs.length < take) break;
  }

  if (!truncated && readyIds.length > 0) {
    let pageCursor: string | undefined;
    while (scanned < maxRows) {
      const take = Math.min(BATCH, maxRows - scanned);
      const pages = await prisma.lawDocumentPage.findMany({
        where: {
          documentId: { in: readyIds },
          ...(pageCursor ? { id: { gt: pageCursor } } : {}),
        },
        orderBy: { id: "asc" },
        take,
        select: { id: true, documentId: true, page: true, text: true },
      });
      if (pages.length === 0) break;
      for (const row of pages) {
        scanned += 1;
        const meta = docMeta.get(row.documentId);
        if (!meta) continue;
        const text = await openLawText(
          prisma,
          {
            table: "law_document_pages",
            column: "text",
            rowId: row.id,
            spaceId: lawCase.spaceId,
            owner: row.documentId,
          },
          row.text,
        );
        collectHitIfMatch(
          input.query,
          {
            kind: "page",
            documentId: row.documentId,
            title: meta.title,
            text,
            page: row.page,
            createdAtMs: meta.createdAtMs,
          },
          hitsAcc,
        );
        pageCursor = row.id;
        if (scanned >= maxRows) {
          truncated = true;
          break;
        }
      }
      if (pages.length < take) break;
    }
  }

  if (!truncated && readyIds.length > 0) {
    let segCursor: string | undefined;
    while (scanned < maxRows) {
      const take = Math.min(BATCH, maxRows - scanned);
      const segments = await prisma.lawTranscriptSegment.findMany({
        where: {
          documentId: { in: readyIds },
          ...(segCursor ? { id: { gt: segCursor } } : {}),
        },
        orderBy: { id: "asc" },
        take,
        select: { id: true, documentId: true, startMs: true, text: true },
      });
      if (segments.length === 0) break;
      for (const row of segments) {
        scanned += 1;
        const meta = docMeta.get(row.documentId);
        if (!meta) continue;
        const text = await openLawText(
          prisma,
          {
            table: "law_transcript_segments",
            column: "text",
            rowId: row.id,
            spaceId: lawCase.spaceId,
            owner: row.documentId,
          },
          row.text,
        );
        collectHitIfMatch(
          input.query,
          {
            kind: "segment",
            documentId: row.documentId,
            title: meta.title,
            text,
            startMs: row.startMs,
            createdAtMs: meta.createdAtMs,
          },
          hitsAcc,
        );
        segCursor = row.id;
        if (scanned >= maxRows) {
          truncated = true;
          break;
        }
      }
      if (segments.length < take) break;
    }
  }

  if (!truncated && readyIds.length > 0) {
    let frameCursor: string | undefined;
    while (scanned < maxRows) {
      const take = Math.min(BATCH, maxRows - scanned);
      const frames = await prisma.lawMediaFrame.findMany({
        where: {
          documentId: { in: readyIds },
          ...(frameCursor ? { id: { gt: frameCursor } } : {}),
        },
        orderBy: { id: "asc" },
        take,
        select: { id: true, documentId: true, tMs: true, caption: true },
      });
      if (frames.length === 0) break;
      for (const row of frames) {
        scanned += 1;
        const meta = docMeta.get(row.documentId);
        if (!meta) continue;
        const caption = await openLawText(
          prisma,
          {
            table: "law_media_frames",
            column: "caption",
            rowId: row.id,
            spaceId: lawCase.spaceId,
            owner: row.documentId,
          },
          row.caption,
        );
        if (caption.trim()) {
          collectHitIfMatch(
            input.query,
            {
              kind: "frame",
              documentId: row.documentId,
              title: meta.title,
              text: caption,
              startMs: row.tMs,
              createdAtMs: meta.createdAtMs,
            },
            hitsAcc,
          );
        }
        frameCursor = row.id;
        if (scanned >= maxRows) {
          truncated = true;
          break;
        }
      }
      if (frames.length < take) break;
    }
  }

  const ranked = sortRankedHits(hitsAcc);
  const pageHits = ranked.slice(offset, offset + limit);
  const nextOffset = offset + pageHits.length;
  const nextCursor = nextOffset < ranked.length ? String(nextOffset) : null;
  const durationMs = Date.now() - started;

  return {
    hits: pageHits,
    truncated,
    nextCursor,
    scanned,
    durationMs,
  };
}

/**
 * Score a preloaded set of rows (used by scale tests and unit tables).
 * Stops collecting after `maxRows` when provided via the rows array length.
 */
export function searchPreloaded(
  query: string,
  rows: readonly SearchableRow[],
  options: { limit?: number; cursor?: string | null; maxRows?: number } = {},
): { hits: SearchHit[]; truncated: boolean; nextCursor: string | null; scanned: number } {
  const maxRows = options.maxRows ?? rows.length;
  const scannedRows = rows.slice(0, maxRows);
  const truncated = rows.length > maxRows;
  const ranked = rankSearchHits(query, scannedRows);
  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), LIMIT_MAX);
  const offset = parseCursor(options.cursor);
  const hits = ranked.slice(offset, offset + limit);
  const nextOffset = offset + hits.length;
  return {
    hits,
    truncated,
    nextCursor: nextOffset < ranked.length ? String(nextOffset) : null,
    scanned: scannedRows.length,
  };
}

function parseCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const n = Number(cursor);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
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

export function mountSearchRoutes(app: Hono, deps: EditionRouteDeps) {
  app.get("/api/law/cases/:id/search", async (c) => {
    try {
      const actor = await deps.sessionActor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      if (!allowSearch(actor.userId)) {
        return c.json({ error: "Too many requests" }, 429);
      }

      const caseId = c.req.param("id");
      const q = (c.req.query("q") ?? "").trim();
      if (q.length < QUERY_MIN || q.length > QUERY_MAX) {
        return c.json({ error: "Invalid query" }, 400);
      }
      const limitRaw = c.req.query("limit");
      const limit =
        limitRaw !== undefined && limitRaw !== ""
          ? Math.min(Math.max(1, Number(limitRaw) || DEFAULT_LIMIT), LIMIT_MAX)
          : DEFAULT_LIMIT;
      const cursor = c.req.query("cursor") ?? null;

      const result = await runAsTenant(actor, () =>
        searchCaseLibrary(deps.prisma, actor, {
          caseId,
          query: q,
          limit,
          cursor,
        }),
      );
      if ("forbidden" in result) return c.json({ error: "Not found" }, 404);

      // Log counts and duration only — never the query or snippets.
      getLogger().info("law.search", {
        scanned: result.scanned,
        hits: result.hits.length,
        truncated: result.truncated,
        durationMs: result.durationMs,
      });

      return c.json({
        hits: result.hits,
        truncated: result.truncated,
        nextCursor: result.nextCursor,
      });
    } catch (error) {
      getLogger().error("law search", error);
      return c.json({ error: "Couldn't search" }, 500);
    }
  });
}

/** Format milliseconds as HH:MM:SS for result chrome. */
export function formatSearchTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
