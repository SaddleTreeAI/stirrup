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

type LawDb = Pick<PrismaClient, "lawCaseBot" | "lawCaseMember" | "lawDocument" | "lawCase">;

/** Hex or organic shape — not a user-picked picture. */
export function isPlainGeneratedAvatar(color: string): boolean {
  const parsed = parseBotAvatarValue(color);
  return parsed.kind === "color" || parsed.kind === "shape";
}

const CASE_ROLES = [
  {
    role: "manager",
    name: "Case Manager",
    description: "Keeps this case's questions and next steps.",
    instructions: (brief: string) =>
      `You are the Case Manager for one criminal defense matter. Answer only from this case's brief and the retrieved documents. Do not give legal advice. Do not use facts from any other case. If the record does not say it, say so.\n\nCase brief:\n${brief}`,
  },
  {
    role: "documents",
    name: "Documents Expert",
    description: "Reads this case's files.",
    instructions: (brief: string) =>
      `You are the Documents Expert. Answer from the retrieved case documents and quote short phrases from them. Do not give legal advice. Do not use another case.\n\nCase brief:\n${brief}`,
  },
  {
    role: "transcripts",
    name: "Transcripts Expert",
    description: "Reads this case's transcripts.",
    instructions: (brief: string) =>
      `You are the Transcripts Expert. Work from transcripts and recorded statements in this case. Quote short phrases. Do not give legal advice. Do not use another case.\n\nCase brief:\n${brief}`,
  },
  {
    role: "generator",
    name: "Legal Doc Generator",
    description: "Drafts documents for review.",
    instructions: (brief: string) =>
      `You are the Legal Doc Generator. Draft from this case only. Begin every draft with the line: SYNTHETIC DRAFT — NOT FOR FILING. Do not give legal advice. Do not cite a rule that is not in the record. Where authority is missing, write [counsel to add].\n\nCase brief:\n${brief}`,
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

/** Case brief plus keyword hits from that case's library. Undefined for ordinary bots. */
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
    select: { id: true, name: true, brief: true, spaceId: true },
  });
  if (!lawCase) return undefined;
  const documents = await prisma.lawDocument.findMany({
    where: { caseId: link.caseId, kind: "library" },
    select: { id: true, title: true, body: true },
  });
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
    documents.map(async (doc) => ({
      title: doc.title,
      body: await openLawText(
        prisma,
        {
          table: "law_documents",
          column: "body",
          rowId: doc.id,
          spaceId: lawCase.spaceId,
          owner: link.caseId,
        },
        doc.body,
      ),
    })),
  );
  return formatLawContext({
    name: lawCase.name,
    brief,
    snippets: retrieveCaseSnippets(prompt, opened),
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
    select: { spaceId: true },
  });
  if (!lawCase) return;
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
    select: { spaceId: true },
  });
  if (!lawCase) return null;
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
  if (lower.endsWith(".docx") || lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return existing;
  }
  return lawDocumentFilename(title, "review");
}
