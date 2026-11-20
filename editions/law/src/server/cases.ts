// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { parseBotAvatarValue } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { isUniqueViolation } from "@rakazo/db";
import { isLawCaseRole, lawRoleAvatar } from "../shared/avatars.js";
import { formatLawContext, retrieveCaseSnippets } from "./retrieval.js";
import { openLawText, sealLawText } from "./seal.js";

/** Library shelf kinds the UI lists (uploads, notes, and legacy library rows). */
export const LAW_LIBRARY_KINDS = ["library", "upload", "note"] as const;

type LawDb = Pick<
  PrismaClient,
  "lawCaseBot" | "lawCaseMember" | "lawDocument" | "lawDocumentPage" | "lawCase"
>;

function libraryDocType(doc: { mimeType?: string | null; filename: string; kind: string }): string {
  const mime = doc.mimeType?.trim();
  if (mime) return mime;
  const ext = /\.([a-z0-9]+)$/i.exec(doc.filename.trim())?.[1];
  if (ext) return ext.toLowerCase();
  return doc.kind;
}

/** True when the case exists and has not been soft-deleted. */
export async function lawCaseIsOpen(
  prisma: Pick<PrismaClient, "lawCase">,
  caseId: string,
): Promise<boolean> {
  const lawCase = await prisma.lawCase.findUnique({
    where: { id: caseId },
    select: { deletedAt: true },
  });
  return Boolean(lawCase && !lawCase.deletedAt);
}

/** Hex or organic shape — not a user-picked picture. */
export function isPlainGeneratedAvatar(color: string): boolean {
  const parsed = parseBotAvatarValue(color);
  return parsed.kind === "color" || parsed.kind === "shape";
}

const CITE_SOURCES =
  'Cite sources as "[Title, p. N]" using exactly the source labels you were given.';

/** Default thinking level for law case bots; override per role when needed. */
export const LAW_CASE_THINKING_LEVEL = "low" as const;

const CASE_ROLES = [
  {
    role: "manager",
    name: "Case Manager",
    description: "Keeps this case's questions and next steps.",
    thinkingLevel: LAW_CASE_THINKING_LEVEL,
    instructions: (brief: string) =>
      `You are the Case Manager for one criminal defense matter. Answer only from this case's brief and the retrieved documents. Do not give legal advice. Do not use facts from any other case. If the record does not say it, say so. ${CITE_SOURCES}\n\nCase brief:\n${brief}`,
  },
  {
    role: "documents",
    name: "Documents Expert",
    description: "Reads this case's files.",
    thinkingLevel: LAW_CASE_THINKING_LEVEL,
    instructions: (brief: string) =>
      `You are the Documents Expert. Answer from the retrieved case documents and quote short phrases from them. Do not give legal advice. Do not use another case. ${CITE_SOURCES}\n\nCase brief:\n${brief}`,
  },
  {
    role: "transcripts",
    name: "Transcripts Expert",
    description: "Reads this case's transcripts.",
    thinkingLevel: LAW_CASE_THINKING_LEVEL,
    instructions: (brief: string) =>
      `You are the Transcripts Expert. Work from transcripts and recorded statements in this case. Quote short phrases. Do not give legal advice. Do not use another case. ${CITE_SOURCES}\n\nCase brief:\n${brief}`,
  },
  {
    role: "generator",
    name: "Legal Doc Generator",
    description: "Drafts documents for review.",
    thinkingLevel: LAW_CASE_THINKING_LEVEL,
    instructions: (brief: string) =>
      `You are the Legal Doc Generator. Draft from this case only. Begin every draft with the line: SYNTHETIC DRAFT — NOT FOR FILING. Do not give legal advice. Do not cite a rule that is not in the record. Where authority is missing, write [counsel to add]. The draft is your reply in Markdown. Only use the computer when a file is asked for: convert with pandoc, then call save_to_case_library. ${CITE_SOURCES}\n\nCase brief:\n${brief}`,
  },
] as const;

export { CASE_ROLES };

/**
 * Whether a bot belongs to a case the user may open.
 * Ported from law-demo; wired through ServerEdition.botAccess (seam S7).
 */
export async function lawCaseAccess(
  prisma: LawDb,
  userId: string,
  botId: string,
): Promise<"open" | "member" | "denied"> {
  const bots = (prisma as { lawCaseBot?: LawDb["lawCaseBot"] }).lawCaseBot;
  if (typeof bots?.findUnique !== "function") return "open";
  const link = await bots.findUnique({
    where: { botId },
    select: { caseId: true },
  });
  if (!link) return "open";
  const lawCase = await prisma.lawCase.findUnique({
    where: { id: link.caseId },
    select: { deletedAt: true },
  });
  if (!lawCase || lawCase.deletedAt) return "denied";
  const member = await prisma.lawCaseMember.findUnique({
    where: { caseId_userId: { caseId: link.caseId, userId } },
    select: { userId: true },
  });
  return member ? "member" : "denied";
}

/** ServerEdition.botAccess adapter for lawCaseAccess (seam S7). */
export async function lawBotAccess(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
): Promise<"allow" | "deny"> {
  return (await lawCaseAccess(prisma, actor.userId, botId)) === "denied" ? "deny" : "allow";
}

/** Case brief, library manifest, and keyword hits. Undefined for ordinary bots. */
export async function lawTurnNote(
  prisma: LawDb,
  botId: string,
  prompt: string,
): Promise<string | undefined> {
  const link = await prisma.lawCaseBot.findUnique({
    where: { botId },
    select: { caseId: true },
  });
  if (!link) return undefined;
  const lawCase = await prisma.lawCase.findUnique({
    where: { id: link.caseId },
    select: { id: true, name: true, brief: true, spaceId: true, deletedAt: true },
  });
  if (!lawCase || lawCase.deletedAt) return undefined;
  const documents = await prisma.lawDocument.findMany({
    where: {
      caseId: link.caseId,
      kind: { in: [...LAW_LIBRARY_KINDS] },
      deletedAt: null,
    },
    select: {
      id: true,
      title: true,
      body: true,
      filename: true,
      mimeType: true,
      kind: true,
      status: true,
      pageCount: true,
    },
  });
  const processingCount = documents.filter((doc) => doc.status !== "ready").length;
  const ready = documents.filter((doc) => doc.status === "ready");
  const brief = await openLawText(
    prisma,
    {
      table: "law_cases",
      column: "brief",
      rowId: lawCase.id,
      spaceId: lawCase.spaceId,
      owner: lawCase.spaceId,
    },
    lawCase.brief,
  );
  const opened = await Promise.all(
    ready.map(async (doc) => {
      const body = await openLawText(
        prisma,
        {
          table: "law_documents",
          column: "body",
          rowId: doc.id,
          spaceId: lawCase.spaceId,
          owner: link.caseId,
        },
        doc.body,
      );
      const pageRows =
        typeof prisma.lawDocumentPage?.findMany === "function"
          ? await prisma.lawDocumentPage.findMany({
              where: { documentId: doc.id },
              select: { id: true, page: true, text: true, ocr: true },
              orderBy: { page: "asc" },
            })
          : [];
      const pages = await Promise.all(
        pageRows.map(async (row) => ({
          page: row.page,
          ocr: row.ocr,
          text: await openLawText(
            prisma,
            {
              table: "law_document_pages",
              column: "text",
              rowId: row.id,
              spaceId: lawCase.spaceId,
              owner: doc.id,
            },
            row.text,
          ),
        })),
      );
      return { title: doc.title, body, pages: pages.length > 0 ? pages : undefined };
    }),
  );
  return formatLawContext({
    name: lawCase.name,
    brief,
    snippets: retrieveCaseSnippets(prompt, opened),
    manifest: ready.map((doc) => ({
      id: doc.id,
      filename: doc.filename.trim() || doc.title,
      type: libraryDocType(doc),
      pageCount: doc.pageCount ?? null,
    })),
    processingCount,
  });
}

/** Hide other cases' bots from this bot's teammate list. */
export async function limitLawTeammates<T extends { id: string }>(
  prisma: Pick<PrismaClient, "lawCaseBot">,
  botId: string,
  teammates: readonly T[],
): Promise<T[]> {
  const link = await prisma.lawCaseBot.findUnique({
    where: { botId },
    select: { caseId: true },
  });
  if (!link) return [...teammates];
  const rows = await prisma.lawCaseBot.findMany({ select: { caseId: true, botId: true } });
  const sameCase = new Set(
    rows.filter((row) => row.caseId === link.caseId).map((row) => row.botId),
  );
  const anyCase = new Set(rows.map((row) => row.botId));
  return teammates.filter((bot) => sameCase.has(bot.id) || !anyCase.has(bot.id));
}

export function lawDocumentFilename(title: string, kind: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (kind === "review") return `${slug || "draft"}.md`;
  return `${slug || "document"}.txt`;
}

/** The Legal Doc Generator's reply is the draft waiting for review. */
export async function saveLawReviewDraft(
  prisma: Pick<PrismaClient, "lawCaseBot" | "lawDocument" | "lawCase">,
  input: { botId: string; runId: string; text: string },
): Promise<void> {
  const text = input.text.trim();
  if (!text) return;
  const link = await prisma.lawCaseBot.findUnique({
    where: { botId: input.botId },
    select: { caseId: true, role: true },
  });
  if (link?.role !== "generator") return;
  const lawCase = await prisma.lawCase.findUnique({
    where: { id: link.caseId },
    select: { spaceId: true, deletedAt: true },
  });
  if (!lawCase || lawCase.deletedAt) return;
  const title =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("SYNTHETIC DRAFT"))
      ?.slice(0, 120) ?? "Draft";
  const id = randomUUID();
  const body = await sealLawText(
    prisma,
    {
      table: "law_documents",
      column: "body",
      rowId: id,
      spaceId: lawCase.spaceId,
      owner: link.caseId,
    },
    text,
  );
  try {
    await prisma.lawDocument.create({
      data: {
        id,
        caseId: link.caseId,
        title,
        filename: lawDocumentFilename(title, "review"),
        body,
        kind: "review",
        version: 1,
        sourceRunId: input.runId,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return;
    throw error;
  }
}

/** Edition hook adapter for onReplyFinalized (seam R3). */
export async function saveLawReviewDraftHook(
  prisma: PrismaClient,
  input: { botId: string; runId: string; text: string },
): Promise<void> {
  await saveLawReviewDraft(prisma, input);
}

/** Attach an existing Space bot to a case so it stays out of other environments. */
export async function attachBotToLawCase(
  prisma: Pick<PrismaClient, "lawCase" | "lawCaseMember" | "lawCaseBot" | "bot">,
  input: { caseId: string; userId: string; botId: string; role?: string },
): Promise<{ role: string } | null> {
  if (!(await lawCaseIsOpen(prisma, input.caseId))) return null;
  const member = await prisma.lawCaseMember.findUnique({
    where: { caseId_userId: { caseId: input.caseId, userId: input.userId } },
    select: { userId: true },
  });
  if (!member) return null;
  const existing = await prisma.lawCaseBot.findUnique({
    where: { botId: input.botId },
    select: { caseId: true, role: true },
  });
  if (existing) {
    if (existing.caseId !== input.caseId) return null;
    return { role: existing.role };
  }
  const role = input.role?.trim() || `custom:${input.botId}`;
  await prisma.lawCaseBot.create({
    data: { caseId: input.caseId, role, botId: input.botId },
  });
  if (isLawCaseRole(role)) {
    const picture = lawRoleAvatar(role);
    if (picture) {
      const bot = await prisma.bot.findUnique({
        where: { id: input.botId },
        select: { color: true },
      });
      if (bot && isPlainGeneratedAvatar(bot.color)) {
        await prisma.bot.update({
          where: { id: input.botId },
          data: { color: picture },
        });
      }
    }
  }
  return { role };
}

/**
 * Set role pictures on case bots that still carry a generated hex/shape.
 * Skips any bot whose color is already a data image (user-chosen).
 */
export async function backfillLawAvatars(
  prisma: Pick<PrismaClient, "lawCaseBot" | "bot">,
): Promise<{ updated: number; skipped: number }> {
  const links = await prisma.lawCaseBot.findMany({
    select: { botId: true, role: true },
  });
  let updated = 0;
  let skipped = 0;
  for (const link of links) {
    if (!isLawCaseRole(link.role)) {
      skipped += 1;
      continue;
    }
    const picture = lawRoleAvatar(link.role);
    if (!picture) {
      skipped += 1;
      continue;
    }
    const bot = await prisma.bot.findUnique({
      where: { id: link.botId },
      select: { color: true },
    });
    if (!bot || !isPlainGeneratedAvatar(bot.color)) {
      skipped += 1;
      continue;
    }
    await prisma.bot.update({
      where: { id: link.botId },
      data: { color: picture },
    });
    updated += 1;
  }
  return { updated, skipped };
}

/** Save an edited review draft as a new version; the previous body stays. */
export async function saveLawDocumentVersion(
  prisma: Pick<PrismaClient, "lawCaseMember" | "lawDocument" | "lawCase">,
  input: { caseId: string; userId: string; documentId: string; body: string; title?: string },
): Promise<
  | {
      id: string;
      title: string;
      filename: string;
      kind: string;
      body: string;
      version: number;
      rootId: string;
      createdAt: Date;
    }
  | null
  | "forbidden"
> {
  const member = await prisma.lawCaseMember.findUnique({
    where: { caseId_userId: { caseId: input.caseId, userId: input.userId } },
    select: { userId: true },
  });
  if (!member) return "forbidden";
  const lawCase = await prisma.lawCase.findUnique({
    where: { id: input.caseId },
    select: { spaceId: true, deletedAt: true },
  });
  if (!lawCase || lawCase.deletedAt) return null;
  const current = await prisma.lawDocument.findFirst({
    where: { id: input.documentId, caseId: input.caseId },
    select: {
      id: true,
      title: true,
      filename: true,
      kind: true,
      version: true,
      rootId: true,
    },
  });
  if (!current) return null;
  if (current.kind !== "review") return "forbidden";
  const rootId = current.rootId ?? current.id;
  const latest = await prisma.lawDocument.findFirst({
    where: {
      caseId: input.caseId,
      OR: [{ id: rootId }, { rootId }],
    },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const version = (latest?.version ?? current.version) + 1;
  const title = input.title?.trim() || current.title;
  const filename = editableFilename(current.filename, title);
  const id = randomUUID();
  const sealed = await sealLawText(
    prisma,
    {
      table: "law_documents",
      column: "body",
      rowId: id,
      spaceId: lawCase.spaceId,
      owner: input.caseId,
    },
    input.body,
  );
  const created = await prisma.lawDocument.create({
    data: {
      id,
      caseId: input.caseId,
      title,
      filename,
      body: sealed,
      kind: "review",
      version,
      rootId,
    },
    select: {
      id: true,
      title: true,
      filename: true,
      kind: true,
      body: true,
      version: true,
      rootId: true,
      createdAt: true,
    },
  });
  return {
    ...created,
    body: input.body,
    rootId: created.rootId ?? rootId,
  };
}

function editableFilename(existing: string, title: string): string {
  const lower = existing.toLowerCase();
  // Keep markdown names; .docx cannot be edited in place, so a new version is .md.
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return existing;
  }
  return lawDocumentFilename(title, "review");
}
