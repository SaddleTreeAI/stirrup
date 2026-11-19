import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEdition } from "../edition/active.js";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router-test-support.js";
import { loadMessagePage } from "../thread-message-pages.js";
import { threadSnapshot } from "../thread-snapshot.js";
import { resolveThreadTarget, sendThreadMessage, threadHead } from "../thread-target.js";

vi.mock("../thread-target.js", async (original) => ({
  ...(await original<typeof import("../thread-target.js")>()),
  resolveThreadTarget: vi.fn(async () => ({ kind: "bot", botId: "bot-1", threadId: "thread-1" })),
  threadHead: vi.fn(async () => ({ threadId: "thread-1", cursor: -1 })),
  sendThreadMessage: vi.fn(async () => ({
    taskId: "task-1",
    runId: "run-1",
    seq: 1,
    runIds: ["run-1"],
  })),
}));
vi.mock("../thread-snapshot.js", () => ({
  threadSnapshot: vi.fn(async () => ({
    threadId: "thread-1",
    cursor: -1,
    messages: [],
    olderCursor: null,
    botId: "bot-1",
    run: null,
  })),
}));
vi.mock("../thread-message-pages.js", async (original) => ({
  ...(await original<typeof import("../thread-message-pages.js")>()),
  loadMessagePage: vi.fn(async () => ({
    threadId: "thread-1",
    messages: [],
    olderCursor: null,
  })),
}));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  modelSetup: vi.fn(async () => ({
    needsModel: false,
    hasDeployment: false,
    creditsAvailable: false,
  })),
}));
vi.mock("../edition/active.js", () => ({
  getEdition: vi.fn(() => ({})),
}));

const actor: Actor = {
  spaceId: "space-test",
  userId: "user-test",
  email: "user@example.test",
  isDeploymentOwner: false,
};

const botAccess = vi.fn(async (): Promise<"allow" | "deny"> => "allow");

function client() {
  const router = createRouter({
    prisma: {
      $queryRaw: vi.fn().mockResolvedValue([{ bypass: null }]),
      taughtSkill: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    env: {
      webOrigin: "http://localhost:5173",
      defaultProvider: "fake",
      defaultModel: "fake",
      maxAttachmentsPerMessage: 4,
    },
    dataDir: "/tmp/thread-bot-access-test",
    events: { follow: vi.fn(async function* () {}) },
  } as unknown as RouterDeps);
  return createRouterClient(router, { context: { actor } });
}

beforeEach(() => {
  botAccess.mockReset();
  botAccess.mockResolvedValue("allow");
  vi.mocked(getEdition).mockReturnValue({ botAccess } as never);
  vi.mocked(resolveThreadTarget).mockResolvedValue({
    kind: "bot",
    botId: "bot-1",
    threadId: "thread-1",
  } as never);
  vi.mocked(threadHead).mockClear();
  vi.mocked(threadSnapshot).mockClear();
  vi.mocked(loadMessagePage).mockClear();
  vi.mocked(sendThreadMessage).mockClear();
});

describe("threads botAccess seam", () => {
  it("refuses head, get, messages and send when botAccess denies", async () => {
    botAccess.mockResolvedValue("deny");
    const threads = client().threads;
    await expect(threads.head({ botId: "bot-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(threads.get({ botId: "bot-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(threads.messages({ botId: "bot-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      threads.send({ botId: "bot-1", text: "hi", clientNonce: "n-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(threadHead).not.toHaveBeenCalled();
    expect(threadSnapshot).not.toHaveBeenCalled();
    expect(loadMessagePage).not.toHaveBeenCalled();
    expect(sendThreadMessage).not.toHaveBeenCalled();
  });

  it("refuses subscribe on the first next when botAccess denies", async () => {
    botAccess.mockResolvedValue("deny");
    const stream = await client().threads.subscribe({ botId: "bot-1", cursor: -1 });
    await expect(stream.next()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("proceeds when botAccess allows", async () => {
    const threads = client().threads;
    await expect(threads.head({ botId: "bot-1" })).resolves.toEqual({
      threadId: "thread-1",
      cursor: -1,
    });
    await expect(threads.get({ botId: "bot-1" })).resolves.toMatchObject({
      threadId: "thread-1",
      botId: "bot-1",
    });
    await expect(threads.messages({ botId: "bot-1" })).resolves.toEqual({
      threadId: "thread-1",
      messages: [],
      olderCursor: null,
    });
    await expect(threads.send({ botId: "bot-1", text: "hi", clientNonce: "n-2" })).resolves.toEqual(
      { taskId: "task-1", runId: "run-1", seq: 1, runIds: ["run-1"] },
    );
    expect(botAccess).toHaveBeenCalled();
    expect(threadHead).toHaveBeenCalled();
    expect(threadSnapshot).toHaveBeenCalled();
    expect(loadMessagePage).toHaveBeenCalled();
    expect(sendThreadMessage).toHaveBeenCalled();
  });

  it("skips the hook when the edition has no botAccess", async () => {
    vi.mocked(getEdition).mockReturnValue({} as never);
    await expect(client().threads.head({ botId: "bot-1" })).resolves.toEqual({
      threadId: "thread-1",
      cursor: -1,
    });
    expect(botAccess).not.toHaveBeenCalled();
    expect(threadHead).toHaveBeenCalled();
  });

  it("never calls the hook for a group target", async () => {
    vi.mocked(resolveThreadTarget).mockResolvedValue({
      kind: "group",
      groupId: "group-1",
      threadId: "thread-g",
      memberBotIds: ["bot-1"],
    } as never);
    await expect(client().threads.head({ groupId: "group-1" })).resolves.toEqual({
      threadId: "thread-1",
      cursor: -1,
    });
    expect(botAccess).not.toHaveBeenCalled();
    expect(threadHead).toHaveBeenCalled();
  });
});
