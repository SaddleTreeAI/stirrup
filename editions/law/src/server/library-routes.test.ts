// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { createHash } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { EditionFiles } from "@rakazo/edition-sdk";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountLawRoutes } from "./routes.js";

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

function fakeFiles(overrides?: Partial<EditionFiles>): EditionFiles {
  return {
    maxBytes: 1024,
    store: vi.fn(async (input) => ({
      artifactId: "artifact-1",
      sizeBytes: input.bytes.byteLength,
      mediaType: input.mediaType || "application/octet-stream",
    })),
    open: vi.fn(async () => ({
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("FILE"));
          controller.close();
        },
      }),
      size: 4,
      mediaType: "application/pdf",
    })),
    ...overrides,
  };
}

function mount(
  prisma: Record<string, unknown>,
  options: { signedIn?: boolean; files?: EditionFiles | null } = {},
) {
  const app = new Hono();
  mountLawRoutes(app, {
    prisma: prisma as never,
    sessionActor: async (request) =>
      (options.signedIn ?? true) && request.headers.get("authorization") ? actor : null,
    files: options.files === null ? undefined : (options.files ?? fakeFiles()),
  });
  return app;
}

type FakePrisma = {
  lawCaseMember: { findUnique: ReturnType<typeof vi.fn> };
  lawCase?: { findUnique?: ReturnType<typeof vi.fn> };
  lawDocument?: {
    findFirst?: ReturnType<typeof vi.fn>;
    findMany?: ReturnType<typeof vi.fn>;
    create?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
    updateMany?: ReturnType<typeof vi.fn>;
  };
  lawDocumentPage?: {
    findMany?: ReturnType<typeof vi.fn>;
    deleteMany?: ReturnType<typeof vi.fn>;
  };
  lawJob?: { updateMany?: ReturnType<typeof vi.fn> };
  lawTranscriptSegment?: {
    findMany?: ReturnType<typeof vi.fn>;
  };
};

function memberPrisma(extra: Partial<FakePrisma> = {}): FakePrisma {
  return {
    lawCaseMember: {
      findUnique: vi.fn(async () => ({ userId: actor.userId })),
    },
    lawCase: {
      findUnique: vi.fn(async () => ({ spaceId: actor.spaceId, deletedAt: null })),
    },
    ...extra,
  };
}

describe("library routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uploads a file on the happy path", async () => {
    const createdAt = new Date("2026-03-01T00:00:00.000Z");
    const prisma = memberPrisma({
      lawDocument: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          id: "doc-1",
          rootId: null,
          version: 1,
          createdAt,
        })),
      },
    });
    const files = fakeFiles();
    const app = mount(prisma, { files });
    const form = new FormData();
    form.set(
      "file",
      new File([new TextEncoder().encode("hello")], "notes.txt", { type: "text/plain" }),
    );
    const response = await app.request("/api/law/cases/case-1/documents/upload", {
      method: "POST",
      headers: { authorization: "Bearer test" },
      body: form,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      document: { id: string; kind: string; hasOriginal: boolean };
    };
    expect(body.document).toMatchObject({
      id: "doc-1",
      kind: "upload",
      hasOriginal: true,
      source: "upload",
    });
    expect(files.store).toHaveBeenCalled();
  });

  it("returns 401 without a session on upload", async () => {
    const app = mount({}, { signedIn: false });
    const form = new FormData();
    form.set("file", new File(["x"], "a.txt"));
    const response = await app.request("/api/law/cases/case-1/documents/upload", {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(401);
  });

  it("returns 404 for a non-member on every library write/read", async () => {
    const prisma = {
      lawCaseMember: { findUnique: vi.fn(async () => null) },
    };
    const app = mount(prisma);
    const form = new FormData();
    form.set("file", new File(["x"], "a.txt"));
    const upload = await app.request("/api/law/cases/case-1/documents/upload", {
      method: "POST",
      headers: { authorization: "Bearer test" },
      body: form,
    });
    expect(upload.status).toBe(404);

    const note = await app.request("/api/law/cases/case-1/documents", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ title: "Note" }),
    });
    expect(note.status).toBe(404);

    const rename = await app.request("/api/law/cases/case-1/documents/doc-1", {
      method: "PATCH",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(rename.status).toBe(404);

    const del = await app.request("/api/law/cases/case-1/documents/doc-1", {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });
    expect(del.status).toBe(404);

    const download = await app.request("/api/law/cases/case-1/documents/doc-1/file", {
      headers: { authorization: "Bearer test" },
    });
    expect(download.status).toBe(404);

    const pages = await app.request("/api/law/cases/case-1/documents/doc-1/pages?from=1&to=1", {
      headers: { authorization: "Bearer test" },
    });
    expect(pages.status).toBe(404);
  });

  it("rejects oversized uploads with 413", async () => {
    const prisma = memberPrisma({
      lawDocument: { findFirst: vi.fn(async () => null) },
    });
    const files = fakeFiles({ maxBytes: 4 });
    const app = mount(prisma, { files });
    const form = new FormData();
    form.set("file", new File([new Uint8Array(8)], "big.bin"));
    const response = await app.request("/api/law/cases/case-1/documents/upload", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-length": "20" },
      body: form,
    });
    expect(response.status).toBe(413);
  });

  it("returns 409 with existingId for duplicate content", async () => {
    const bytes = new TextEncoder().encode("same");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const prisma = memberPrisma({
      lawDocument: {
        findFirst: vi.fn(async () => ({ id: "existing-doc" })),
      },
    });
    const app = mount(prisma);
    const form = new FormData();
    form.set("file", new File([bytes], "dup.txt", { type: "text/plain" }));
    const response = await app.request("/api/law/cases/case-1/documents/upload", {
      method: "POST",
      headers: { authorization: "Bearer test" },
      body: form,
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Duplicate content",
      existingId: "existing-doc",
    });
    expect(sha256).toHaveLength(64);
  });

  it("creates a blank note document", async () => {
    const createdAt = new Date("2026-03-01T00:00:00.000Z");
    const prisma = memberPrisma({
      lawDocument: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          id: "note-1",
          rootId: null,
          version: 1,
          createdAt,
          artifactId: null,
        })),
      },
    });
    const app = mount(prisma);
    const response = await app.request("/api/law/cases/case-1/documents", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ title: "Interview notes" }),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      document: {
        kind: "note",
        source: "edit",
        filename: "interview-notes.md",
        hasOriginal: false,
      },
    });
  });

  it("renames every row in a version family", async () => {
    const createdAt = new Date("2026-03-01T00:00:00.000Z");
    const updates: Array<{ id: string; title: string; filename: string }> = [];
    const prisma = memberPrisma({
      lawDocument: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            id: "doc-v2",
            title: "Old",
            filename: "old.md",
            rootId: "doc-v1",
          })
          .mockResolvedValueOnce({
            id: "doc-v2",
            title: "New title",
            filename: "new-title.md",
            kind: "review",
            body: "body",
            version: 2,
            rootId: "doc-v1",
            createdAt,
            source: "edit",
            mimeType: "text/markdown",
            sizeBytes: 4,
            status: "ready",
            statusDetail: "",
            pageCount: null,
            durationMs: null,
            artifactId: null,
          }),
        findMany: vi.fn(async () => [
          { id: "doc-v1", filename: "old.md" },
          { id: "doc-v2", filename: "old.md" },
        ]),
        update: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { id: string };
            data: { title: string; filename: string };
          }) => {
            updates.push({ id: where.id, title: data.title, filename: data.filename });
            return {};
          },
        ),
      },
    });
    const app = mount(prisma);
    const response = await app.request("/api/law/cases/case-1/documents/doc-v2", {
      method: "PATCH",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    });
    expect(response.status).toBe(200);
    expect(updates).toEqual([
      { id: "doc-v1", title: "New title", filename: "new-title.md" },
      { id: "doc-v2", title: "New title", filename: "new-title.md" },
    ]);
  });

  it("returns 404 for library routes on a soft-deleted case", async () => {
    const prisma = memberPrisma({
      lawCase: {
        findUnique: vi.fn(async () => ({ spaceId: actor.spaceId, deletedAt: new Date() })),
      },
      lawDocument: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    });
    const app = mount(prisma);
    const note = await app.request("/api/law/cases/case-1/documents", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ title: "Note", body: "text" }),
    });
    expect(note.status).toBe(404);
    expect(prisma.lawDocument?.create).not.toHaveBeenCalled();

    const del = await app.request("/api/law/cases/case-1/documents/doc-1", {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });
    expect(del.status).toBe(404);
    expect(prisma.lawDocument?.findFirst).not.toHaveBeenCalled();
  });

  it("soft deletes a family, hides it from list, and cancels queued jobs", async () => {
    const { tryRecordAuditEvent } = await import("@rakazo/db");
    const updateMany = vi.fn(async () => ({ count: 2 }));
    const deletePages = vi.fn(async () => ({ count: 3 }));
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([{ id: "doc-1" }, { id: "doc-2" }])
      .mockResolvedValueOnce([]);
    const cancelJobs = vi.fn(async () => ({ count: 1 }));
    const prisma = memberPrisma({
      lawDocument: {
        findFirst: vi.fn(async () => ({ id: "doc-1", rootId: null })),
        findMany,
        updateMany,
      },
      lawDocumentPage: { deleteMany: deletePages },
      lawJob: { updateMany: cancelJobs },
    });
    const app = mount(prisma);

    const del = await app.request("/api/law/cases/case-1/documents/doc-1", {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });
    expect(del.status).toBe(204);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["doc-1", "doc-2"] } },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
    expect(deletePages).toHaveBeenCalledWith({
      where: { documentId: { in: ["doc-1", "doc-2"] } },
    });
    expect(cancelJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "queued" }),
        data: expect.objectContaining({ status: "cancelled" }),
      }),
    );
    expect(tryRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "document.deleted" }),
    );

    const list = await app.request("/api/law/cases/case-1/documents", {
      headers: { authorization: "Bearer test" },
    });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual({ documents: [] });
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { caseId: "case-1", deletedAt: null } }),
    );
  });

  it("downloads with attachment by default and inline only for pdf and media", async () => {
    const open = vi.fn(async () => ({
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
      size: 3,
      mediaType: "application/pdf",
    }));
    const findFirst = vi.fn(async () => ({
      id: "doc-1",
      filename: "complaint.pdf",
      mimeType: "application/pdf",
      artifactId: "artifact-1",
    }));
    const prisma = memberPrisma({ lawDocument: { findFirst } });
    const app = mount(prisma, { files: fakeFiles({ open }) });

    const attachment = await app.request("/api/law/cases/case-1/documents/doc-1/file", {
      headers: { authorization: "Bearer test" },
    });
    expect(attachment.status).toBe(200);
    expect(attachment.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(attachment.headers.get("x-content-type-options")).toBe("nosniff");
    expect(attachment.headers.get("content-type")).toBe("application/pdf");

    const inlinePdf = await app.request("/api/law/cases/case-1/documents/doc-1/file?inline=1", {
      headers: { authorization: "Bearer test" },
    });
    expect(inlinePdf.headers.get("content-disposition")).toMatch(/^inline;/);

    findFirst.mockResolvedValueOnce({
      id: "doc-html",
      filename: "page.html",
      mimeType: "text/html",
      artifactId: "artifact-2",
    });
    const inlineHtml = await app.request("/api/law/cases/case-1/documents/doc-html/file?inline=1", {
      headers: { authorization: "Bearer test" },
    });
    expect(inlineHtml.headers.get("content-disposition")).toMatch(/^attachment;/);

    findFirst.mockResolvedValueOnce({
      id: "doc-svg",
      filename: "icon.svg",
      mimeType: "image/svg+xml",
      artifactId: "artifact-3",
    });
    const inlineSvg = await app.request("/api/law/cases/case-1/documents/doc-svg/file?inline=1", {
      headers: { authorization: "Bearer test" },
    });
    expect(inlineSvg.headers.get("content-disposition")).toMatch(/^attachment;/);

    findFirst.mockResolvedValueOnce({
      id: "doc-audio",
      filename: "clip.mp3",
      mimeType: "audio/mpeg",
      artifactId: "artifact-4",
    });
    const inlineAudio = await app.request(
      "/api/law/cases/case-1/documents/doc-audio/file?inline=1",
      { headers: { authorization: "Bearer test" } },
    );
    expect(inlineAudio.headers.get("content-disposition")).toMatch(/^inline;/);
  });

  it("returns opened page text for members and rejects oversized ranges", async () => {
    const prisma = memberPrisma({
      lawDocument: {
        findFirst: vi.fn(async () => ({ id: "doc-1" })),
      },
      lawDocumentPage: {
        findMany: vi.fn(async () => [
          { id: "p1", page: 1, text: "page one" },
          { id: "p2", page: 2, text: "page two" },
        ]),
      },
    });
    const app = mount(prisma);
    const ok = await app.request("/api/law/cases/case-1/documents/doc-1/pages?from=1&to=2", {
      headers: { authorization: "Bearer test" },
    });
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({
      pages: [
        { page: 1, text: "page one" },
        { page: 2, text: "page two" },
      ],
    });

    const tooWide = await app.request("/api/law/cases/case-1/documents/doc-1/pages?from=1&to=25", {
      headers: { authorization: "Bearer test" },
    });
    expect(tooWide.status).toBe(400);

    const backwards = await app.request("/api/law/cases/case-1/documents/doc-1/pages?from=5&to=2", {
      headers: { authorization: "Bearer test" },
    });
    expect(backwards.status).toBe(400);
  });

  it("rejects empty or overlong rename titles with 400", async () => {
    const app = mount(memberPrisma());
    const empty = await app.request("/api/law/cases/case-1/documents/doc-1", {
      method: "PATCH",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ title: "  " }),
    });
    expect(empty.status).toBe(400);
    const long = await app.request("/api/law/cases/case-1/documents/doc-1", {
      method: "PATCH",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ title: "x".repeat(201) }),
    });
    expect(long.status).toBe(400);
  });

  it("exports transcript as txt, srt, and vtt for members", async () => {
    const prisma = memberPrisma({
      lawDocument: {
        findFirst: vi.fn(async () => ({ id: "doc-1", filename: "hearing.mp4" })),
      },
      lawTranscriptSegment: {
        findMany: vi.fn(async () => [
          {
            id: "seg-1",
            idx: 0,
            startMs: 0,
            endMs: 1500,
            speaker: null,
            text: "One",
          },
          {
            id: "seg-2",
            idx: 1,
            startMs: 2000,
            endMs: 3500,
            speaker: null,
            text: "Two",
          },
        ]),
      },
    });
    const app = mount(prisma);

    const txt = await app.request("/api/law/cases/case-1/documents/doc-1/transcript?format=txt", {
      headers: { authorization: "Bearer test" },
    });
    expect(txt.status).toBe(200);
    expect(txt.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(txt.headers.get("content-disposition")).toMatch(/hearing\.txt/);
    expect(await txt.text()).toBe("[00:00:00] One\n[00:00:02] Two");

    const srt = await app.request("/api/law/cases/case-1/documents/doc-1/transcript?format=srt", {
      headers: { authorization: "Bearer test" },
    });
    expect(srt.status).toBe(200);
    expect(await srt.text()).toContain("00:00:00,000 --> 00:00:01,500");

    const vtt = await app.request("/api/law/cases/case-1/documents/doc-1/transcript?format=vtt", {
      headers: { authorization: "Bearer test" },
    });
    expect(vtt.status).toBe(200);
    const vttBody = await vtt.text();
    expect(vttBody).toMatch(/^WEBVTT\n/);
    expect(vttBody).toContain("00:00:00.000 --> 00:00:01.500");
  });

  it("lists segments in a time window with a 500 cap", async () => {
    const findMany = vi.fn(async (_args: { take?: number }) => [
      {
        id: "seg-1",
        idx: 2,
        startMs: 1000,
        endMs: 2000,
        speaker: null,
        text: "mid",
      },
    ]);
    const prisma = memberPrisma({
      lawDocument: {
        findFirst: vi.fn(async () => ({ id: "doc-1", filename: "hearing.mp4" })),
      },
      lawTranscriptSegment: { findMany },
    });
    const app = mount(prisma);
    const response = await app.request(
      "/api/law/cases/case-1/documents/doc-1/segments?from=500&to=3000",
      { headers: { authorization: "Bearer test" } },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      segments: [{ idx: 2, startMs: 1000, endMs: 2000, speaker: null, text: "mid" }],
      limit: 500,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 500,
        where: expect.objectContaining({
          documentId: "doc-1",
          startMs: { lte: 3000 },
          endMs: { gte: 500 },
        }),
      }),
    );
  });

  it("returns 404 for transcript and segments when not a member", async () => {
    const prisma = {
      lawCaseMember: { findUnique: vi.fn(async () => null) },
    };
    const app = mount(prisma);
    const transcript = await app.request(
      "/api/law/cases/case-1/documents/doc-1/transcript?format=txt",
      { headers: { authorization: "Bearer test" } },
    );
    expect(transcript.status).toBe(404);
    const segments = await app.request("/api/law/cases/case-1/documents/doc-1/segments", {
      headers: { authorization: "Bearer test" },
    });
    expect(segments.status).toBe(404);
  });

  it("rejects an unknown transcript format", async () => {
    const app = mount(memberPrisma());
    const response = await app.request(
      "/api/law/cases/case-1/documents/doc-1/transcript?format=pdf",
      { headers: { authorization: "Bearer test" } },
    );
    expect(response.status).toBe(400);
  });
});
