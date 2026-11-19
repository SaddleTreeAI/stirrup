// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { Actor } from "@rakazo/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountLawRoutes } from "./routes.js";

vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...actual,
    runAsTenant: async <T>(_actor: Actor, work: () => Promise<T>) => work(),
    runAsSystem: async <T>(_reason: string, work: () => Promise<T>) => work(),
  };
});

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user-1@example.test",
  isDeploymentOwner: false,
};

function mount(prisma: Record<string, unknown>, signedIn = true) {
  const app = new Hono();
  mountLawRoutes(app, {
    prisma: prisma as never,
    sessionActor: async (request) =>
      signedIn && request.headers.get("authorization") ? actor : null,
  });
  return app;
}

describe("mountLawRoutes auth and shapes", () => {
  it("returns 401 without a session", async () => {
    const app = mount({}, false);
    const response = await app.request("/api/law/cases");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Sign in required" });
  });

  it("returns the cases list shape the web UI expects", async () => {
    const prisma = {
      lawCaseMember: {
        findMany: vi.fn(async () => [{ caseId: "case-1" }]),
      },
      lawCase: {
        findMany: vi.fn(async () => [
          {
            id: "case-1",
            slug: "ward",
            name: "Commonwealth v. Ward",
            position: 0,
          },
        ]),
      },
      lawCaseBot: {
        findMany: vi.fn(async () => [
          { caseId: "case-1", role: "manager", botId: "bot-m" },
          { caseId: "case-1", role: "documents", botId: "bot-d" },
          { caseId: "case-1", role: "transcripts", botId: "bot-t" },
          { caseId: "case-1", role: "generator", botId: "bot-g" },
        ]),
      },
      bot: {
        findMany: vi.fn(async () => [
          { id: "bot-m", name: "Case Manager" },
          { id: "bot-d", name: "Documents Expert" },
          { id: "bot-t", name: "Transcripts Expert" },
          { id: "bot-g", name: "Legal Doc Generator" },
        ]),
      },
    };
    const app = mount(prisma);
    const response = await app.request("/api/law/cases", {
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cases: [
        {
          id: "case-1",
          slug: "ward",
          name: "Commonwealth v. Ward",
          bots: [
            { role: "manager", name: "Case Manager", botId: "bot-m" },
            { role: "documents", name: "Documents Expert", botId: "bot-d" },
            { role: "transcripts", name: "Transcripts Expert", botId: "bot-t" },
            { role: "generator", name: "Legal Doc Generator", botId: "bot-g" },
          ],
        },
      ],
    });
  });

  it("names the Space that holds cases when the current organization has none", async () => {
    const prisma = {
      lawCaseMember: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ caseId: "case-elsewhere" }]),
      },
      lawCase: {
        findMany: vi.fn(async () => [{ spaceId: "space-defense", position: 0 }]),
      },
      spaceMember: {
        findFirst: vi.fn(async () => ({ spaceId: "space-defense" })),
      },
    };
    const app = mount(prisma);
    const response = await app.request("/api/law/cases", {
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cases: [],
      casesSpaceId: "space-defense",
    });
  });

  it("returns 404 for another user's case documents", async () => {
    const prisma = {
      lawCaseMember: {
        findUnique: vi.fn(async () => null),
      },
    };
    const app = mount(prisma);
    const response = await app.request("/api/law/cases/other-case/documents", {
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("returns the documents list shape the web UI expects", async () => {
    const createdAt = new Date("2026-01-02T03:04:05.000Z");
    const prisma = {
      lawCaseMember: {
        findUnique: vi.fn(async () => ({ userId: actor.userId })),
      },
      lawDocument: {
        findMany: vi.fn(async () => [
          {
            id: "doc-1",
            title: "Complaint",
            filename: "complaint.pdf",
            kind: "library",
            body: "SYNTHETIC complaint",
            version: 1,
            rootId: null,
            createdAt,
            source: "bot",
            mimeType: "application/pdf",
            sizeBytes: 1200,
            status: "ready",
            statusDetail: "",
            pageCount: 3,
            durationMs: null,
            artifactId: "artifact-1",
          },
          {
            id: "doc-2",
            title: "Motion draft",
            filename: "motion-draft.md",
            kind: "review",
            body: "SYNTHETIC DRAFT — NOT FOR FILING",
            version: 2,
            rootId: "doc-root",
            createdAt,
            source: "edit",
            mimeType: "text/markdown",
            sizeBytes: 40,
            status: "ready",
            statusDetail: "",
            pageCount: null,
            durationMs: null,
            artifactId: null,
          },
        ]),
      },
    };
    const app = mount(prisma);
    const response = await app.request("/api/law/cases/case-1/documents", {
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      documents: [
        {
          id: "doc-1",
          title: "Complaint",
          filename: "complaint.pdf",
          kind: "library",
          body: "SYNTHETIC complaint",
          version: 1,
          rootId: "doc-1",
          createdAt: createdAt.toISOString(),
          source: "bot",
          mimeType: "application/pdf",
          sizeBytes: 1200,
          status: "ready",
          statusDetail: "",
          pageCount: 3,
          durationMs: null,
          hasOriginal: true,
        },
        {
          id: "doc-2",
          title: "Motion draft",
          filename: "motion-draft.md",
          kind: "review",
          body: "SYNTHETIC DRAFT — NOT FOR FILING",
          version: 2,
          rootId: "doc-root",
          createdAt: createdAt.toISOString(),
          source: "edit",
          mimeType: "text/markdown",
          sizeBytes: 40,
          status: "ready",
          statusDetail: "",
          pageCount: null,
          durationMs: null,
          hasOriginal: false,
        },
      ],
    });
    expect(prisma.lawDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { caseId: "case-1", deletedAt: null } }),
    );
  });
});
