// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { isOwnerRole, organizationRole, runAsTenant, tryRecordAuditEvent } from "@rakazo/db";
import type { EditionRouteDeps } from "@rakazo/edition-sdk";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import { lawCaseRetentionDays } from "./constants.js";

type CaseDb = Pick<
  PrismaClient,
  | "lawCase"
  | "lawCaseMember"
  | "lawCaseBot"
  | "lawDocument"
  | "lawJob"
  | "space"
  | "spaceMember"
  | "member"
  | "$transaction"
>;

export type CaseDeleteDenial = "not_found" | "forbidden" | "legal_hold";

export type SoftDeleteCaseResult =
  | { ok: true; id: string; purgeAfter: Date | null }
  | { ok: false; reason: CaseDeleteDenial };

export type RestoreCaseResult =
  | { ok: true; id: string }
  | { ok: false; reason: CaseDeleteDenial | "not_deleted" };

/** Whether this actor may soft-delete or restore the case (creator, space owner, or org admin). */
export async function canManageLawCase(
  prisma: CaseDb,
  actor: Actor,
  input: { createdBy: string | null; spaceId: string; isMember: boolean },
): Promise<boolean> {
  if (!input.isMember) return false;
  if (input.createdBy !== null && input.createdBy === actor.userId) return true;
  return isSpaceOwnerOrOrgAdmin(prisma, actor, input.spaceId);
}

/** Space owner (spaceMember.role) or organization owner/admin for the Space's organization. */
export async function isSpaceOwnerOrOrgAdmin(
  prisma: CaseDb,
  actor: Actor,
  spaceId: string,
): Promise<boolean> {
  const spaceMember = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId, userId: actor.userId } },
    select: { role: true },
  });
  if (spaceMember && isOwnerRole(spaceMember.role)) return true;

  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    select: { organizationId: true },
  });
  if (!space) return false;
  const member = await prisma.member.findFirst({
    where: { organizationId: space.organizationId, userId: actor.userId },
    select: { role: true },
  });
  if (!member) return false;
  const role = organizationRole(member.role);
  return role === "owner" || role === "admin";
}

export async function softDeleteLawCase(
  prisma: CaseDb,
  actor: Actor,
  caseId: string,
  now = new Date(),
): Promise<SoftDeleteCaseResult> {
  const lawCase = await prisma.lawCase.findUnique({
    where: { id: caseId },
    select: {
      id: true,
      spaceId: true,
      createdBy: true,
      legalHold: true,
      deletedAt: true,
    },
  });
  if (!lawCase || lawCase.spaceId !== actor.spaceId) return { ok: false, reason: "not_found" };
  if (lawCase.deletedAt) return { ok: false, reason: "not_found" };

  const member = await prisma.lawCaseMember.findUnique({
    where: { caseId_userId: { caseId, userId: actor.userId } },
    select: { userId: true },
  });
  if (!member) return { ok: false, reason: "not_found" };

  const allowed = await canManageLawCase(prisma, actor, {
    createdBy: lawCase.createdBy,
    spaceId: lawCase.spaceId,
    isMember: true,
  });
  if (!allowed) return { ok: false, reason: "forbidden" };
  if (lawCase.legalHold) return { ok: false, reason: "legal_hold" };

  const retentionDays = lawCaseRetentionDays();
  const purgeAfter =
    retentionDays === 0 ? null : new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);

  const documentCount = await prisma.lawDocument.count({
    where: { caseId, deletedAt: null },
  });
  const botCount = await prisma.lawCaseBot.count({ where: { caseId } });

  await prisma.$transaction(async (tx) => {
    await tx.lawCase.update({
      where: { id: caseId },
      data: {
        deletedAt: now,
        deletedBy: actor.userId,
        purgeAfter,
      },
    });
    await tx.lawJob.updateMany({
      where: { caseId, status: { in: ["queued", "running"] } },
      data: { status: "cancelled", updatedAt: now },
    });
  });

  await tryRecordAuditEvent({
    action: "law.case.deleted",
    actor: { type: "user", id: actor.userId },
    spaceId: actor.spaceId,
    userId: actor.userId,
    target: { type: "case", id: caseId },
    metadata: {
      caseId,
      actorId: actor.userId,
      purgeAfter: purgeAfter ? purgeAfter.toISOString() : null,
      documentCount,
      botCount,
    },
  });

  return { ok: true, id: caseId, purgeAfter };
}

export async function restoreLawCase(
  prisma: CaseDb,
  actor: Actor,
  caseId: string,
): Promise<RestoreCaseResult> {
  const lawCase = await prisma.lawCase.findUnique({
    where: { id: caseId },
    select: {
      id: true,
      spaceId: true,
      createdBy: true,
      deletedAt: true,
    },
  });
  if (!lawCase || lawCase.spaceId !== actor.spaceId) return { ok: false, reason: "not_found" };
  if (!lawCase.deletedAt) return { ok: false, reason: "not_deleted" };

  const member = await prisma.lawCaseMember.findUnique({
    where: { caseId_userId: { caseId, userId: actor.userId } },
    select: { userId: true },
  });
  if (!member) return { ok: false, reason: "not_found" };

  const allowed = await canManageLawCase(prisma, actor, {
    createdBy: lawCase.createdBy,
    spaceId: lawCase.spaceId,
    isMember: true,
  });
  if (!allowed) return { ok: false, reason: "forbidden" };

  await prisma.lawCase.update({
    where: { id: caseId },
    data: { deletedAt: null, deletedBy: null, purgeAfter: null },
  });

  await tryRecordAuditEvent({
    action: "law.case.restored",
    actor: { type: "user", id: actor.userId },
    spaceId: actor.spaceId,
    userId: actor.userId,
    target: { type: "case", id: caseId },
    metadata: {
      caseId,
      actorId: actor.userId,
    },
  });

  return { ok: true, id: caseId };
}

export async function listDeletedLawCases(prisma: CaseDb, actor: Actor) {
  if (!(await isSpaceOwnerOrOrgAdmin(prisma, actor, actor.spaceId))) {
    return "forbidden" as const;
  }
  const rows = await prisma.lawCase.findMany({
    where: { spaceId: actor.spaceId, deletedAt: { not: null } },
    orderBy: [{ deletedAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      slug: true,
      name: true,
      deletedAt: true,
      purgeAfter: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    deletedAt: row.deletedAt!.toISOString(),
    purgeAfter: row.purgeAfter ? row.purgeAfter.toISOString() : null,
  }));
}

/** DELETE / restore / deleted-list routes for cases. */
export function mountCaseRoutes(app: Hono, deps: EditionRouteDeps) {
  app.delete("/api/law/cases/:id", async (c) => {
    try {
      const actor = await deps.sessionActor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const caseId = c.req.param("id");
      const result = await runAsTenant(actor, () => softDeleteLawCase(deps.prisma, actor, caseId));
      if (!result.ok) {
        if (result.reason === "not_found") return c.json({ error: "Not found" }, 404);
        if (result.reason === "forbidden") return c.json({ error: "Forbidden" }, 403);
        return c.json({ error: "This case is on legal hold" }, 409);
      }
      return c.json({
        id: result.id,
        purgeAfter: result.purgeAfter ? result.purgeAfter.toISOString() : null,
      });
    } catch (error) {
      getLogger().error("law delete case", error);
      return c.json({ error: "Couldn't delete case" }, 500);
    }
  });

  app.post("/api/law/cases/:id/restore", async (c) => {
    try {
      const actor = await deps.sessionActor(c.req.raw);
      if (!actor) return c.json({ error: "Sign in required" }, 401);
      const caseId = c.req.param("id");
      const result = await runAsTenant(actor, () => restoreLawCase(deps.prisma, actor, caseId));
      if (!result.ok) {
        if (result.reason === "not_found") return c.json({ error: "Not found" }, 404);
        if (result.reason === "forbidden") return c.json({ error: "Forbidden" }, 403);
        return c.json({ error: "Not found" }, 404);
      }
      return c.json({ id: result.id });
    } catch (error) {
      getLogger().error("law restore case", error);
      return c.json({ error: "Couldn't restore case" }, 500);
    }
  });
}
