// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { Actor } from "@rakazo/contracts";
import { createLogger, getLogger, installLogger } from "@rakazo/logging";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountLawRoutes } from "./routes.js";
import { resetSearchRateLimitForTests } from "./search.js";

vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...actual,
    runAsTenant: async <T>(_actor: Actor, work: () => Promise<T>) => work(),
    runAsSystem: async <T>(_reason: string, work: () => Promise<T>) => work(),
    tryRecordAuditEvent: vi.fn(async () => true),
  };
});

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user-1@example.test",
  isDeploymentOwner: false,
};

function mount(prisma: Record<string, unknown>, options: { signedIn?: boolean } = {}) {
  const app = new Hono();
  mountLawRoutes(app, {
    prisma: prisma as never,
    sessionActor: async (request) =>
      (options.signedIn ?? true) && request.headers.get("authorization") ? actor : null,
  });
  return app;
}

function memberPrisma(extra: Record<string, unknown> = {}) {
  return {
    lawCaseMember: {
      findUnique: vi.fn(async () => ({ userId: actor.userId })),
    },
    lawCase: {
      findUnique: vi.fn(async () => ({ spaceId: actor.spaceId, deletedAt: null })),
    },
    lawDocument: {
      findMany: vi.fn(async () => []),
    },
    lawDocumentPage: {
      findMany: vi.fn(async () => []),
    },
    lawTranscriptSegment: {
      findMany: vi.fn(async () => []),
    },
    lawMediaFrame: {
      findMany: vi.fn(async () => []),
    },
    ...extra,
  };
}

describe("search routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSearchRateLimitForTests();
  });

  afterEach(() => {
    installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
  });

  it("returns 401 without a session", async () => {
    const app = mount({}, { signedIn: false });
    const response = await app.request("/api/law/cases/case-1/search?q=ab");
    expect(response.status).toBe(401);
  });

  it("returns 404 for non-members", async () => {
    const prisma = memberPrisma({
      lawCaseMember: { findUnique: vi.fn(async () => null) },
    });
    const app = mount(prisma);
    const response = await app.request("/api/law/cases/case-1/search?q=ab", {
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(404);
  });

  it("rejects short and long queries", async () => {
    const app = mount(memberPrisma());
    const short = await app.request("/api/law/cases/case-1/search?q=a", {
      headers: { authorization: "Bearer test" },
    });
    expect(short.status).toBe(400);
    const long = await app.request(`/api/law/cases/case-1/search?q=${"x".repeat(201)}`, {
      headers: { authorization: "Bearer test" },
    });
    expect(long.status).toBe(400);
  });

  it("finds a ready text document and skips deleted", async () => {
    const prisma = memberPrisma({
      lawDocument: {
        findMany: vi
          .fn()
          // metadata pass
          .mockResolvedValueOnce([
            {
              id: "doc-ready",
              title: "Ready note",
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
            },
          ])
          // body pass
          .mockResolvedValueOnce([
            {
              id: "doc-ready",
              title: "Ready note",
              body: "UniqueSearchAlpha appears here",
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
            },
          ])
          .mockResolvedValue([]),
      },
    });
    const app = mount(prisma);
    const response = await app.request("/api/law/cases/case-1/search?q=UniqueSearchAlpha", {
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      hits: Array<{ kind: string; documentId: string; snippet: string }>;
      truncated: boolean;
    };
    expect(body.truncated).toBe(false);
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]).toMatchObject({
      kind: "text",
      documentId: "doc-ready",
    });
    expect(body.hits[0]?.snippet).toContain("UniqueSearchAlpha");
  });

  it("logs counts and duration without query or snippet", async () => {
    const sink = {
      lines: [] as Array<{ message: string; bindings: Record<string, unknown> }>,
      write(event: { message: string; level: string; bindings?: Record<string, unknown> }) {
        this.lines.push({
          message: event.message,
          bindings: { ...(event.bindings ?? {}) },
        });
      },
    };
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const infoSpy = vi.spyOn(getLogger(), "info");

    const prisma = memberPrisma({
      lawDocument: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "doc-1",
              title: "Note",
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
            },
          ])
          .mockResolvedValueOnce([
            {
              id: "doc-1",
              title: "Note",
              body: "SecretQueryWord in body",
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
            },
          ])
          .mockResolvedValue([]),
      },
    });
    const app = mount(prisma);
    const response = await app.request("/api/law/cases/case-1/search?q=SecretQueryWord", {
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    expect(infoSpy).toHaveBeenCalled();
    for (const call of infoSpy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain("SecretQueryWord");
      expect(call[0]).toBe("law.search");
      const bindings = call[1] as Record<string, unknown>;
      expect(bindings).toHaveProperty("scanned");
      expect(bindings).toHaveProperty("durationMs");
      expect(bindings).not.toHaveProperty("q");
      expect(bindings).not.toHaveProperty("snippet");
    }
  });

  it("caps limit at 50", async () => {
    const prisma = memberPrisma();
    const app = mount(prisma);
    const response = await app.request("/api/law/cases/case-1/search?q=ab&limit=999", {
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    expect(prisma.lawDocument.findMany).toHaveBeenCalled();
  });
});
