// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createRepos, runAsTenant } from "@rakazo/db";
import type { EditionRouteDeps } from "@rakazo/edition-sdk";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import { lawRoleAvatar } from "../shared/avatars.js";
import { isSpaceOwnerOrOrgAdmin, listDeletedLawCases, mountCaseRoutes } from "./case-routes.js";
import { attachBotToLawCase, CASE_ROLES, saveLawDocumentVersion } from "./cases.js";
import { LAW_CHAT_MODEL_ID, LAW_CHAT_PROVIDER, lawCaseRetentionDays } from "./constants.js";
import { mountLibraryRoutes, serializeDocument } from "./library-routes.js";
import { preferredCasesSpaceId } from "./preferred-space.js";
import { openLawText, sealLawText } from "./seal.js";
import { mountSearchRoutes } from "./search.js";

const ROLE_ORDER = ["manager", "documents", "transcripts", "generator"];

export function mountLawRoutes(app: Hono, deps: EditionRouteDeps) {
  mountLibraryRoutes(app, deps);
  mountSearchRoutes(app, deps);
  mountCaseRoutes(app, deps);
  app.get("/api/law/cases", async (c) => {
    try {
      const actor = await deps.sessionActor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      if (c.req.query("deleted") === "1") {
        const deleted = await runAsTenant(actor, () => listDeletedLawCases(deps.prisma, actor));
        if (deleted === "forbidden") return c.json({ error: "Forbidden" }, 403);
        return c.json({ cases: deleted });
      }
      const listed = await runAsTenant(actor, () => listCases(deps.prisma, actor));
      if (listed.cases.length > 0) {
        return c.json({
          cases: listed.cases,
          deletedBotIds: listed.deletedBotIds,
          retentionDays: listed.retentionDays,
          canViewDeleted: listed.canViewDeleted,
        });
      }
      const casesSpaceId = await preferredCasesSpaceId(deps.prisma, actor.userId, actor.spaceId);
      return casesSpaceId
        ? c.json({
            cases: listed.cases,
            deletedBotIds: listed.deletedBotIds,
            retentionDays: listed.retentionDays,
            canViewDeleted: listed.canViewDeleted,
            casesSpaceId,
          })
        : c.json({
            cases: listed.cases,
            deletedBotIds: listed.deletedBotIds,
            retentionDays: listed.retentionDays,
            canViewDeleted: listed.canViewDeleted,
          });
    } catch (error) {
      getLogger().error("law cases", error);
      return c.json({ error: "Couldn't load cases" }, 500);
    }
  });

  app.post("/api/law/cases", async (c) => {
    try {
      const actor = await deps.sessionActor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const body = (await c.req.json().catch(() => null)) as {
        name?: unknown;
        brief?: unknown;
      } | null;
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name) return c.json({ error: "Name required" }, 400);
      const brief =
        typeof body?.brief === "string" && body.brief.trim()
          ? body.brief.trim()
          : `Case file for ${name}.`;
      const created = await runAsTenant(actor, () =>
        createCaseWithBots(deps.prisma, actor, { name, brief }),
      );
      if (!created) return c.json({ error: "Couldn't create case" }, 409);
      return c.json({ case: created }, 201);
    } catch (error) {
      getLogger().error("law create case", error);
      return c.json({ error: "Couldn't create case" }, 500);
    }
  });

  app.post("/api/law/cases/:id/bots", async (c) => {
    try {
      const actor = await deps.sessionActor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const caseId = c.req.param("id");
      const body = (await c.req.json().catch(() => null)) as { botId?: unknown } | null;
      const botId = typeof body?.botId === "string" ? body.botId.trim() : "";
      if (!botId) return c.json({ error: "botId required" }, 400);
      const linked = await runAsTenant(actor, async () => {
        const bot = await deps.prisma.bot.findFirst({
          where: { id: botId, spaceId: actor.spaceId },
          select: { id: true },
        });
        if (!bot) return null;
        return attachBotToLawCase(deps.prisma, {
          caseId,
          userId: actor.userId,
          botId,
        });
      });
      if (!linked) return c.json({ error: "Not found" }, 404);
      return c.json({ botId, role: linked.role });
    } catch (error) {
      getLogger().error("law attach bot", error);
      return c.json({ error: "Couldn't attach bot" }, 500);
    }
  });

  app.get("/api/law/cases/:id/documents", async (c) => {
    try {
      const actor = await deps.sessionActor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const caseId = c.req.param("id");
      const documents = await runAsTenant(actor, () =>
        listDocuments(deps.prisma, actor.userId, caseId),
      );
      if (!documents) return c.json({ error: "Not found" }, 404);
      return c.json({ documents });
    } catch (error) {
      getLogger().error("law documents", error);
      return c.json({ error: "Couldn't load documents" }, 500);
    }
  });

  app.post("/api/law/cases/:id/documents/:docId/versions", async (c) => {
    try {
      const actor = await deps.sessionActor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const caseId = c.req.param("id");
      const documentId = c.req.param("docId");
      const body = (await c.req.json().catch(() => null)) as {
        body?: unknown;
        title?: unknown;
      } | null;
      const text = typeof body?.body === "string" ? body.body : "";
      if (!text.trim()) return c.json({ error: "Body required" }, 400);
      const title = typeof body?.title === "string" ? body.title : undefined;
      const result = await runAsTenant(actor, () =>
        saveLawDocumentVersion(deps.prisma, {
          caseId,
          userId: actor.userId,
          documentId,
          body: text,
          title,
        }),
      );
      if (result === "forbidden") return c.json({ error: "Forbidden" }, 403);
      if (!result) return c.json({ error: "Not found" }, 404);
      return c.json(
        {
          document: {
            ...result,
            createdAt: result.createdAt.toISOString(),
          },
        },
        201,
      );
    } catch (error) {
      getLogger().error("law document version", error);
      return c.json({ error: "Couldn't save version" }, 500);
    }
  });
}

async function listCases(prisma: PrismaClient, actor: Actor) {
  const retentionDays = lawCaseRetentionDays();
  const memberships = await prisma.lawCaseMember.findMany({
    where: { userId: actor.userId },
    select: { caseId: true },
  });
  const caseIds = memberships.map((row) => row.caseId);
  if (caseIds.length === 0) {
    return {
      cases: [],
      deletedBotIds: [] as string[],
      retentionDays,
      canViewDeleted: await isSpaceOwnerOrOrgAdmin(prisma, actor, actor.spaceId),
    };
  }

  const allCases = await prisma.lawCase.findMany({
    where: { id: { in: caseIds } },
    select: {
      id: true,
      slug: true,
      name: true,
      position: true,
      createdBy: true,
      deletedAt: true,
      spaceId: true,
    },
  });
  const openCases = allCases.filter((item) => !item.deletedAt);
  const deletedCaseIds = allCases.filter((item) => item.deletedAt).map((item) => item.id);
  const openCaseIds = openCases.map((item) => item.id);

  const links = await prisma.lawCaseBot.findMany({
    where: { caseId: { in: caseIds } },
    select: { caseId: true, role: true, botId: true },
  });
  const deletedBotIds = [
    ...new Set(
      links.filter((link) => deletedCaseIds.includes(link.caseId)).map((link) => link.botId),
    ),
  ];

  const openLinks = links.filter((link) => openCaseIds.includes(link.caseId));
  const botIds = [...new Set(openLinks.map((link) => link.botId))];
  const bots =
    botIds.length === 0
      ? []
      : await prisma.bot.findMany({
          where: { id: { in: botIds } },
          select: { id: true, name: true },
        });
  const botName = new Map(bots.map((bot) => [bot.id, bot.name]));
  const botsByCase = new Map<string, Array<{ role: string; botId: string; name: string }>>();
  for (const link of openLinks) {
    const name = botName.get(link.botId);
    if (!name) continue;
    const list = botsByCase.get(link.caseId) ?? [];
    list.push({ role: link.role, botId: link.botId, name });
    botsByCase.set(link.caseId, list);
  }

  const elevated = await isSpaceOwnerOrOrgAdmin(prisma, actor, actor.spaceId);
  const cases = openCases
    .sort((a, b) => a.position - b.position)
    .map((item) => {
      const canDelete = elevated || (item.createdBy !== null && item.createdBy === actor.userId);
      return {
        id: item.id,
        slug: item.slug,
        name: item.name,
        canDelete,
        bots: [...(botsByCase.get(item.id) ?? [])]
          .sort((a, b) => {
            const left = ROLE_ORDER.indexOf(a.role);
            const right = ROLE_ORDER.indexOf(b.role);
            const leftRank = left === -1 ? ROLE_ORDER.length : left;
            const rightRank = right === -1 ? ROLE_ORDER.length : right;
            if (leftRank !== rightRank) return leftRank - rightRank;
            return a.role.localeCompare(b.role);
          })
          .map((bot) => ({ role: bot.role, name: bot.name, botId: bot.botId })),
      };
    });

  return { cases, deletedBotIds, retentionDays, canViewDeleted: elevated };
}

async function listDocuments(prisma: PrismaClient, userId: string, caseId: string) {
  const member = await prisma.lawCaseMember.findUnique({
    where: { caseId_userId: { caseId, userId } },
    select: { userId: true },
  });
  if (!member) return null;
  const lawCase = await prisma.lawCase.findUnique({
    where: { id: caseId },
    select: { spaceId: true, deletedAt: true },
  });
  if (!lawCase || lawCase.deletedAt) return null;
  const documents = await prisma.lawDocument.findMany({
    where: { caseId, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { version: "asc" }],
    select: {
      id: true,
      title: true,
      filename: true,
      kind: true,
      body: true,
      version: true,
      rootId: true,
      createdAt: true,
      source: true,
      mimeType: true,
      sizeBytes: true,
      status: true,
      statusDetail: true,
      pageCount: true,
      durationMs: true,
      artifactId: true,
      derivedArtifactId: true,
    },
  });
  return Promise.all(
    documents.map(async (doc) =>
      serializeDocument({
        ...doc,
        body: await openLawText(
          prisma,
          {
            table: "law_documents",
            column: "body",
            rowId: doc.id,
            spaceId: lawCase.spaceId,
            owner: caseId,
          },
          doc.body,
        ),
      }),
    ),
  );
}

async function createCaseWithBots(
  prisma: PrismaClient,
  actor: Actor,
  input: { name: string; brief: string },
) {
  const slugBase = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  let slug = slugBase || `case-${Date.now().toString(36)}`;
  const existing = await prisma.lawCase.findUnique({
    where: { spaceId_slug: { spaceId: actor.spaceId, slug } },
    select: { id: true },
  });
  if (existing) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
  return finishCreateCase(prisma, actor, { ...input, slug });
}

async function finishCreateCase(
  prisma: PrismaClient,
  actor: Actor,
  input: { name: string; brief: string; slug: string },
) {
  const max = await prisma.lawCase.aggregate({
    where: { spaceId: actor.spaceId },
    _max: { position: true },
  });
  const position = (max._max.position ?? -1) + 1;
  const caseId = randomUUID();
  const brief = await sealLawText(
    prisma,
    {
      table: "law_cases",
      column: "brief",
      rowId: caseId,
      spaceId: actor.spaceId,
      owner: actor.spaceId,
    },
    input.brief,
  );
  const lawCase = await prisma.lawCase.create({
    data: {
      id: caseId,
      spaceId: actor.spaceId,
      slug: input.slug,
      name: input.name,
      brief,
      position,
      createdBy: actor.userId,
    },
  });
  await prisma.lawCaseMember.create({
    data: { caseId: lawCase.id, userId: actor.userId },
  });
  const repos = createRepos(prisma);
  const bots = [];
  for (const role of CASE_ROLES) {
    const bot = await repos.createBot(actor, {
      name: role.name,
      description: role.description,
      instructions: role.instructions(input.brief),
      notifyOnFinish: false,
      dailyCheckIns: false,
      fleetManagement: false,
      color: lawRoleAvatar(role.role),
      spawnKey: `law:${input.slug}:${role.role}`,
      modelProvider: LAW_CHAT_PROVIDER,
      modelId: LAW_CHAT_MODEL_ID,
      thinkingLevel: "medium",
    });
    await prisma.lawCaseBot.create({
      data: { caseId: lawCase.id, role: role.role, botId: bot.id },
    });
    bots.push({ role: role.role, name: bot.name, botId: bot.id });
  }
  return {
    id: lawCase.id,
    slug: lawCase.slug,
    name: lawCase.name,
    canDelete: true,
    bots,
  };
}
