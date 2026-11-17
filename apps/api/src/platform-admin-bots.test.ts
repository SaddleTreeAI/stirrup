import type { PlatformAdminCursor } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizePlatformInspection } from "./platform-admin.js";
import { inspectPlatformBot } from "./platform-admin-bots.js";

vi.mock("./platform-admin.js", () => ({
  authorizePlatformInspection: vi.fn(async () => undefined),
}));

const createdAt = new Date("2026-11-16T12:00:00.000Z");
const cursor = (createdAt: Date, id: string): PlatformAdminCursor => ({
  createdAt: createdAt.toISOString(),
  id,
});

function row(id: string, index: number) {
  return { id, createdAt: new Date(createdAt.getTime() - index * 1000) };
}

function pageOf<T extends { id: string; createdAt: Date }>(make: (index: number) => T) {
  return Array.from({ length: 51 }, (_, index) => make(index));
}

function inspectionPrisma() {
  const messages = pageOf((index) => ({
    ...row(`message-${index}`, index),
    threadId: "thread-1",
    seq: 51 - index,
    role: "user",
    authorUserId: "user-1",
    blocks: [{ kind: "text", text: `message ${index}` }],
  }));
  const memories = pageOf((index) => ({
    ...row(`memory-${index}`, index),
    scope: "bot",
    path: `/memory/${index}`,
    content: `memory ${index}`,
    revision: 1,
    updatedAt: new Date(createdAt.getTime() - index * 1000),
  }));
  const artifacts = pageOf((index) => ({
    ...row(`artifact-${index}`, index),
    name: `file ${index}`,
    description: null,
    mimeType: "text/plain",
    size: 20,
  }));
  const usage = pageOf((index) => ({
    ...row(`usage-${index}`, index),
    provider: "test",
    model: "test-model",
    inputTokens: 1,
    outputTokens: 2,
    costUsd: null,
  }));
  return {
    bot: {
      findUnique: vi.fn(async () => ({
        id: "bot-1",
        spaceId: "space-1",
        userId: "user-1",
        name: "Planner",
        description: "Plans",
        instructions: "Make a plan",
        modelProvider: null,
        modelId: null,
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
        space: { name: "Team" },
      })),
      findMany: vi.fn(async () => []),
    },
    user: {
      findUnique: vi.fn(async () => ({
        id: "user-1",
        name: "Member",
        email: "member@example.test",
      })),
    },
    thread: {
      findMany: vi.fn(async () =>
        Array.from({ length: 51 }, (_, index) => ({
          ...row(`thread-${index + 1}`, index),
          groupId: index === 0 ? "group-1" : null,
          helperBotId: index === 1 ? "helper-1" : null,
          group: index === 0 ? { name: "Ops" } : null,
          helperBot: index === 1 ? { name: "Research" } : null,
        })),
      ),
      findFirst: vi.fn(async () => ({ id: "thread-1" })),
    },
    message: { findMany: vi.fn(async () => messages) },
    memoryDocument: { findMany: vi.fn(async () => memories) },
    artifact: { findMany: vi.fn(async () => artifacts), findUnique: vi.fn() },
    usageRecord: { findMany: vi.fn(async () => usage) },
  };
}

afterEach(() => vi.clearAllMocks());

describe("platform owner bot inspection", () => {
  it("paginates threads, selected conversation history, memories, files, and usage independently", async () => {
    const prisma = inspectionPrisma();
    const page = await inspectPlatformBot(prisma as never, "owner", "bot-1", {
      threadId: "thread-1",
      threadsBefore: cursor(createdAt, "thread-before"),
      before: cursor(createdAt, "message-before"),
      memoriesBefore: cursor(createdAt, "memory-before"),
      filesBefore: cursor(createdAt, "file-before"),
      usageBefore: cursor(createdAt, "usage-before"),
    });

    expect(page.threads).toHaveLength(50);
    expect(page.threads[0]).toMatchObject({ id: "thread-1", label: "Ops", kind: "group" });
    expect(page.threads[1]).toMatchObject({ id: "thread-2", label: "Research", kind: "helper" });
    expect(page.selectedThreadId).toBe("thread-1");
    expect(page.messages).toHaveLength(50);
    expect(page.memories).toHaveLength(50);
    expect(page.files).toHaveLength(50);
    expect(page.usage).toHaveLength(50);
    expect(page.nextThreadsBefore).not.toBeNull();
    expect(page.nextBefore).not.toBeNull();
    expect(page.nextMemoriesBefore).not.toBeNull();
    expect(page.nextFilesBefore).not.toBeNull();
    expect(page.nextUsageBefore).not.toBeNull();
    expect(prisma.thread.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 51, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    );
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "thread-1" }),
        take: 51,
      }),
    );
    expect(prisma.memoryDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.any(Array) }),
        take: 51,
      }),
    );
    expect(prisma.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.any(Array) }),
        take: 51,
      }),
    );
    expect(prisma.usageRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.any(Array) }),
        take: 51,
      }),
    );
    expect(vi.mocked(authorizePlatformInspection)).toHaveBeenCalledWith(
      prisma,
      "owner",
      "user-1",
      "bot-content",
    );
  });

  it("refuses a selected conversation that is not attached to the inspected bot", async () => {
    const prisma = inspectionPrisma();
    prisma.thread.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      inspectPlatformBot(prisma as never, "owner", "bot-1", { threadId: "foreign-thread" }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });
});
