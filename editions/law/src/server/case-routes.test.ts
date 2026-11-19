// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { Actor } from "@rakazo/contracts";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountLawRoutes } from "./routes.js";

const tryRecordAuditEvent = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>) => true),
);

vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...actual,
    runAsTenant: async <T>(_actor: Actor, work: () => Promise<T>) => work(),
    runAsSystem: async <T>(_reason: string, work: () => Promise<T>) => work(),
    tryRecordAuditEvent,
  };
});

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user-1@example.test",
  isDeploymentOwner: false,
};

function mount(prisma: Record<string, unknown>, signedInActor: Actor | null = actor) {
  const app = new Hono();
  mountLawRoutes(app, {
    prisma: prisma as never,
    sessionActor: async (request) =>
      signedInActor && request.headers.get("authorization") ? signedInActor : null,
  });
  return app;
}

function basePrisma(overrides: Record<string, unknown> = {}) {
  const state = {
    deletedAt: null as Date | null,
    deletedBy: null as string | null,
    purgeAfter: null as Date | null,
    createdBy: "user-1" as string | null,
    legalHold: false,
    jobs: [
      { id: "job-1", status: "queued" },
      { id: "job-2", status: "running" },
    ],
  };
  const prisma = {
    lawCase: {
      findUnique: vi.fn(async () => ({
        id: "case-1",
        spaceId: "space-1",
        createdBy: state.createdBy,
        legalHold: state.legalHold,
        deletedAt: state.deletedAt,
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if ("deletedAt" in data) state.deletedAt = data.deletedAt as Date | null;
        if ("deletedBy" in data) state.deletedBy = data.deletedBy as string | null;
        if ("purgeAfter" in data) state.purgeAfter = data.purgeAfter as Date | null;
        return {};
      }),
    },
    lawCaseMember: {
      findUnique: vi.fn(async () => ({ userId: actor.userId })),
    },
    lawCaseBot: {
      count: vi.fn(async () => 4),
    },
    lawDocument: {
      count: vi.fn(async () => 2),
    },
    lawJob: {
      updateMany: vi.fn(
        async ({ where, data }: { where: { status?: unknown }; data: { status: string } }) => {
          const statuses =
            where.status && typeof where.status === "object" && "in" in where.status
              ? (where.status as { in: string[] }).in
              : null;
          let count = 0;
          for (const job of state.jobs) {
            if (!statuses || statuses.includes(job.status)) {
              job.status = data.status;
              count += 1;
            }
          }
          return { count };
        },
      ),
    },
    spaceMember: {
      findUnique: vi.fn(async () => ({ role: "member" })),
    },
    space: {
      findUnique: vi.fn(async () => ({ organizationId: "org-1" })),
    },
    member: {
      findFirst: vi.fn(async (): Promise<{ role: string } | null> => null),
    },
    $transaction: vi.fn(async (work: (tx: typeof prisma) => Promise<unknown>) => work(prisma)),
    ...overrides,
    __state: state,
  };
  return prisma;
}

describe("case delete and restore", () => {
  beforeEach(() => {
    tryRecordAuditEvent.mockReset();
    tryRecordAuditEvent.mockResolvedValue(true);
    vi.stubEnv("LAW_CASE_RETENTION_DAYS", "30");
  });

  it("lets the creator soft-delete and sets purgeAfter for 30 days", async () => {
    const prisma = basePrisma();
    const before = Date.now();
    const app = mount(prisma);
    const response = await app.request("/api/law/cases/case-1", {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; purgeAfter: string };
    expect(body.id).toBe("case-1");
    const purge = Date.parse(body.purgeAfter);
    expect(purge).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60 * 1000 - 1000);
    expect(purge).toBeLessThanOrEqual(Date.now() + 30 * 24 * 60 * 60 * 1000 + 1000);
    expect(prisma.lawJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { caseId: "case-1", status: { in: ["queued", "running"] } },
        data: expect.objectContaining({ status: "cancelled" }),
      }),
    );
    expect(prisma.__state.jobs.every((job) => job.status === "cancelled")).toBe(true);
    expect(tryRecordAuditEvent).toHaveBeenCalledOnce();
    const audit = tryRecordAuditEvent.mock.calls[0]?.[0];
    expect(audit?.action).toBe("law.case.deleted");
    expect(audit?.metadata).toMatchObject({
      caseId: "case-1",
      actorId: "user-1",
      documentCount: 2,
      botCount: 4,
    });
    expect(JSON.stringify(audit?.metadata ?? {})).not.toMatch(/Ward|Commonwealth|name/i);
  });

  it("sets purgeAfter to null when retention is 0", async () => {
    vi.stubEnv("LAW_CASE_RETENTION_DAYS", "0");
    const prisma = basePrisma();
    const app = mount(prisma);
    const response = await app.request("/api/law/cases/case-1", {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "case-1", purgeAfter: null });
    expect(prisma.__state.purgeAfter).toBeNull();
  });

  it("returns 409 when the case is on legal hold", async () => {
    const prisma = basePrisma();
    prisma.__state.legalHold = true;
    const app = mount(prisma);
    const response = await app.request("/api/law/cases/case-1", {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "This case is on legal hold" });
    expect(prisma.lawCase.update).not.toHaveBeenCalled();
  });

  it("returns 403 for another member who is not the creator", async () => {
    const prisma = basePrisma();
    prisma.__state.createdBy = "user-creator";
    const other: Actor = { ...actor, userId: "user-other" };
    prisma.lawCaseMember.findUnique.mockResolvedValue({ userId: other.userId });
    const app = mount(prisma, other);
    const response = await app.request("/api/law/cases/case-1", {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("lets a space owner delete when createdBy is null", async () => {
    const prisma = basePrisma();
    prisma.__state.createdBy = null;
    prisma.spaceMember.findUnique.mockResolvedValue({ role: "owner" });
    const owner: Actor = { ...actor, userId: "user-owner" };
    prisma.lawCaseMember.findUnique.mockResolvedValue({ userId: owner.userId });
    const app = mount(prisma, owner);
    const response = await app.request("/api/law/cases/case-1", {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
  });

  it("returns 403 for a member when createdBy is null", async () => {
    const prisma = basePrisma();
    prisma.__state.createdBy = null;
    const app = mount(prisma);
    const response = await app.request("/api/law/cases/case-1", {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(403);
  });

  it("returns 404 for a non-member", async () => {
    const prisma = basePrisma({
      lawCaseMember: { findUnique: vi.fn(async () => null) },
    });
    const app = mount(prisma);
    const response = await app.request("/api/law/cases/case-1", {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(404);
  });

  it("lets an organization admin delete another member's case", async () => {
    const prisma = basePrisma();
    prisma.__state.createdBy = "user-creator";
    const admin: Actor = { ...actor, userId: "user-admin" };
    prisma.lawCaseMember.findUnique.mockResolvedValue({ userId: admin.userId });
    prisma.spaceMember.findUnique.mockResolvedValue({ role: "member" });
    prisma.member.findFirst.mockResolvedValue({ role: "admin" });
    const app = mount(prisma, admin);
    const response = await app.request("/api/law/cases/case-1", {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
  });

  it("still deletes when audit recording fails", async () => {
    tryRecordAuditEvent.mockResolvedValue(false);
    const prisma = basePrisma();
    const app = mount(prisma);
    const response = await app.request("/api/law/cases/case-1", {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    expect(prisma.__state.deletedAt).toBeInstanceOf(Date);
  });

  it("restores a deleted case and audits without the name", async () => {
    const prisma = basePrisma();
    prisma.__state.deletedAt = new Date();
    prisma.__state.deletedBy = "user-1";
    prisma.__state.purgeAfter = new Date();
    const app = mount(prisma);
    const response = await app.request("/api/law/cases/case-1/restore", {
      method: "POST",
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "case-1" });
    expect(prisma.__state.deletedAt).toBeNull();
    expect(prisma.__state.purgeAfter).toBeNull();
    expect(tryRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "law.case.restored",
        metadata: expect.objectContaining({ caseId: "case-1", actorId: "user-1" }),
      }),
    );
    const meta = tryRecordAuditEvent.mock.calls[0]?.[0]?.metadata;
    expect(JSON.stringify(meta ?? {})).not.toMatch(/Ward|Commonwealth/i);
  });

  it("lists deleted cases only for owners and admins", async () => {
    const prisma = basePrisma({
      lawCase: {
        findMany: vi.fn(async () => [
          {
            id: "case-1",
            slug: "ward",
            name: "Commonwealth v. Ward",
            deletedAt: new Date("2026-01-01T00:00:00.000Z"),
            purgeAfter: new Date("2026-01-31T00:00:00.000Z"),
          },
        ]),
      },
      spaceMember: { findUnique: vi.fn(async () => ({ role: "owner" })) },
    });
    const app = mount(prisma);
    const allowed = await app.request("/api/law/cases?deleted=1", {
      headers: { authorization: "Bearer test" },
    });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toEqual({
      cases: [
        {
          id: "case-1",
          slug: "ward",
          name: "Commonwealth v. Ward",
          deletedAt: "2026-01-01T00:00:00.000Z",
          purgeAfter: "2026-01-31T00:00:00.000Z",
        },
      ],
    });

    const memberPrisma = basePrisma({
      spaceMember: { findUnique: vi.fn(async () => ({ role: "member" })) },
      member: { findFirst: vi.fn(async () => ({ role: "member" })) },
    });
    const denied = await mount(memberPrisma).request("/api/law/cases?deleted=1", {
      headers: { authorization: "Bearer test" },
    });
    expect(denied.status).toBe(403);
  });
});
