import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditionRunHooks } from "./edition-run-hooks.js";
import { buildTurnPrompt } from "./run-assembly-context.js";
import type { RunContext } from "./run-context.js";
import { createReplyState } from "./run-progress.js";
import { completeRun, consumeRunEvents } from "./run-turn.js";

vi.mock("./reply-context.js", () => ({
  loadReplyContext: vi.fn(async () => undefined),
}));
vi.mock("./shared-space-note.js", () => ({
  loadSharedSpaceNote: vi.fn(async () => undefined),
}));
vi.mock("./group-handoff.js", () => ({
  loadBotGroupDirectory: vi.fn(async () => undefined),
}));

const flushProgress = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./run-progress.js", async (actual) => ({
  ...(await actual<typeof import("./run-progress.js")>()),
  flushProgress,
}));

vi.mock("./run-lifecycle.js", async (actual) => ({
  ...(await actual<typeof import("./run-lifecycle.js")>()),
  renewRunLease: vi.fn(async () => true),
  enqueueSteeringContinuation: vi.fn(async () => {}),
}));

vi.mock("./tool-step-calls.js", async (actual) => ({
  ...(await actual<typeof import("./tool-step-calls.js")>()),
  saveLatestStepScreenshot: vi.fn(async () => {}),
}));

vi.mock("./conversation-memory.js", async (actual) => ({
  ...(await actual<typeof import("./conversation-memory.js")>()),
  answeredSteeringMessageIds: vi.fn(async () => undefined),
  retainsConversationTurn: vi.fn(() => false),
}));

const teammates = [
  { id: "bot-a", name: "Alpha", description: "first" },
  { id: "bot-b", name: "Beta", description: "second" },
];

function promptParts(hooks?: EditionRunHooks) {
  const findMany = vi.fn(async () => teammates);
  const hold = {
    deps: {
      prisma: {
        user: { findUnique: async () => ({ timezone: null }) },
        bot: { findMany },
      },
      editionRunHooks: hooks,
      now: () => new Date("2026-01-15T12:00:00.000Z"),
    },
    run: {
      spaceId: "space-1",
      userId: "user-1",
      trigger: "message",
      sourceMessageId: null,
      routineId: null,
    },
    current: {},
    executionStartedAt: new Date("2026-01-15T12:00:00.000Z"),
    firstLateSince: undefined,
    secrets: [],
    takeover: { takeoverResume: undefined },
  };
  const parts = {
    saved: {
      checkpointModelResolver: undefined,
      savedComputerMode: undefined,
      turnCheckpoint: undefined,
    },
    records: {
      agentSkills: [],
      bot: { id: "bot-self", name: "Self", instructions: "" },
      nonOwnerChatRun: true,
      savedSkills: [],
      task: { prompt: "hello there" },
      thread: { id: "thread-1", groupId: null, historyCompactedUpToSeq: null },
      conversationThread: { groupId: null },
    },
    connected: { connectedPlugins: [], context: {} },
    thread: {
      compactedHistory: { usedLocalSummary: false, summary: undefined },
      people: undefined,
    },
    turnContext: {
      currentTurnImages: undefined,
      currentTurnMessage: undefined,
      history: [],
      historyMessages: [],
      recalledMemory: undefined,
      turnBlocks: [],
    },
    model: {
      resolved: {},
      runModelId: "model",
      runModelProvider: "provider",
    },
    computer: { attachedFilesPrompt: undefined, modelSeesImages: false },
    capabilities: {
      callEndRun: false,
      disabledBuiltinTools: new Set(),
      ownerStartedRun: true,
      voiceCall: false,
    },
    tools: { approvedEffects: [], tools: [] },
    ctx: {} as RunContext,
  };
  return {
    hold: hold as unknown as Parameters<typeof buildTurnPrompt>[0],
    parts: parts as unknown as Parameters<typeof buildTurnPrompt>[1],
    findMany,
  };
}

describe("edition run hooks", () => {
  it("keeps prompt and teammate directory identical when no hooks are set", async () => {
    const bare = promptParts();
    const withEmpty = promptParts({});
    const a = await buildTurnPrompt(bare.hold, bare.parts);
    const b = await buildTurnPrompt(withEmpty.hold, withEmpty.parts);
    expect(b.prompt).toBe(a.prompt);
    expect(b.botDirectory).toBe(a.botDirectory);
    expect(a.botDirectory).toContain("Alpha");
    expect(a.botDirectory).toContain("Beta");
  });

  it("appends turnNote as the last prompt element", async () => {
    const bare = promptParts();
    const withNote = promptParts({
      turnNote: async () => "edition-turn-note",
    });
    const a = await buildTurnPrompt(bare.hold, bare.parts);
    const b = await buildTurnPrompt(withNote.hold, withNote.parts);
    expect(b.prompt.endsWith("edition-turn-note")).toBe(true);
    expect(b.prompt.startsWith(a.prompt)).toBe(true);
    expect(b.prompt.length).toBeGreaterThan(a.prompt.length);
  });

  it("limits the teammate directory to limitTeammates results", async () => {
    const limited = promptParts({
      limitTeammates: async (_prisma, _botId, list) => list.filter((bot) => bot.id === "bot-a"),
    });
    const result = await buildTurnPrompt(limited.hold, limited.parts);
    expect(result.botDirectory).toContain("Alpha");
    expect(result.botDirectory).not.toContain("Beta");
  });
});

describe("edition onReplyFinalized", () => {
  let previous: ReturnType<typeof getLogger>;
  let sink: ReturnType<typeof createTestSink>;

  beforeEach(() => {
    sink = createTestSink();
    previous = getLogger();
    installLogger(createLogger({ service: "test", level: "debug", sinks: [sink] }));
  });
  afterEach(() => installLogger(previous));

  async function completedContext(hooks?: EditionRunHooks) {
    const deps = {
      prisma: {
        message: { findMany: async () => [] },
        run: { updateMany: async () => ({ count: 1 }) },
        thread: {
          findUniqueOrThrow: async () => ({
            nextMessageSeq: 0,
            historyCompactedUpToSeq: null,
          }),
        },
      },
      events: {
        append: vi.fn(),
        finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
      },
      jobs: { enqueue: vi.fn() },
      memory: { commit: vi.fn() },
      sandbox: { writeFile: vi.fn() },
      editionRunHooks: hooks,
      runtime: { describe: () => ({ id: "test-runtime" }) },
    };
    const run = {
      id: "run-1",
      botId: "bot-1",
      spaceId: "space-1",
      userId: "user-1",
      threadId: "thread-1",
      taskId: "task-1",
      trigger: "message",
      routineId: null,
      startedAt: new Date(),
    };
    const reply = await createReplyState(deps as never, run as never, []);
    reply.assembled = "final reply text";
    reply.currentTextSegment = "final reply text";
    reply.messageSegments = [{ kind: "text", text: "final reply text" }];
    const ctx = {
      deps,
      run,
      runId: run.id,
      workerId: "worker-1",
      fence: 1,
      bot: { id: run.botId, name: "Bot" },
      thread: { id: run.threadId },
      attempt: { id: "attempt-1" },
      scripted: false,
      allowSilentEmptyRun: false,
      groupReplyOptional: false,
      emptyResponseText: "…",
      replyMode: "chat",
      secrets: [],
      settleRunningHelpers: async () => {},
      stopHeartbeatAfterCompletion: () => {},
      state: {
        reply,
        approval: { pausePending: false },
        lease: { valid: true, lastCheckAt: 0 },
        computerUse: {},
        toolCallStreak: {},
        toolResults: new Map(),
        overLimitActionCalls: 0,
        handedOff: false,
        terminalCheckpointComplete: false,
      },
      abortController: new AbortController(),
      computer: {
        lazy: { throwIfFailed: () => {} },
        checkpoint: { flush: vi.fn(), markDirty: vi.fn() },
        get: async () => ({}),
        mode: "bot",
      },
      tools: { approvedReplays: { assertDrained: () => {} } },
      source: { messagingChannelRun: false, peerMessage: undefined },
      memory: { semantic: undefined },
      script: undefined,
    } as unknown as RunContext;
    return { ctx, deps };
  }

  it("calls onReplyFinalized once with the final text", async () => {
    const onReplyFinalized = vi.fn(async () => {});
    const { ctx } = await completedContext({ onReplyFinalized });
    await completeRun(ctx);
    expect(onReplyFinalized).toHaveBeenCalledOnce();
    expect(onReplyFinalized).toHaveBeenCalledWith(ctx.deps.prisma, {
      botId: "bot-1",
      runId: "run-1",
      text: "final reply text",
    });
  });

  it("logs and swallows onReplyFinalized errors", async () => {
    const onReplyFinalized = vi.fn(async () => {
      throw new Error("hook failed");
    });
    const { ctx } = await completedContext({ onReplyFinalized });
    await expect(completeRun(ctx)).resolves.toBeUndefined();
    expect(onReplyFinalized).toHaveBeenCalledOnce();
    expect(
      sink.events.some(
        (event) => event.level === "error" && event.message === "edition reply hook",
      ),
    ).toBe(true);
  });
});

describe("edition streamsProgress", () => {
  beforeEach(() => {
    flushProgress.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function streamingContext(hooks?: EditionRunHooks) {
    const deps = {
      prisma: {
        message: { findMany: async () => [] },
        run: {
          findUnique: async () => ({
            status: "running",
            leaseOwner: "worker-1",
            leaseFence: 1,
            checkpoint: null,
          }),
        },
      },
      events: { append: vi.fn(), finalizeRun: vi.fn() },
      editionRunHooks: hooks,
      runtime: { describe: () => ({ id: "edition-mock" }) },
    };
    const run = {
      id: "run-1",
      botId: "bot-1",
      spaceId: "space-1",
      userId: "user-1",
      threadId: "thread-1",
      taskId: "task-1",
      trigger: "message",
    };
    const reply = await createReplyState(deps as never, run as never, []);
    const ctx = {
      deps,
      run,
      runId: run.id,
      workerId: "worker-1",
      fence: 1,
      bot: { id: run.botId },
      thread: { id: run.threadId },
      attempt: { id: "attempt-1" },
      state: {
        reply,
        approval: { pausePending: false },
        lease: { valid: true, lastCheckAt: 0 },
        computerUse: {},
        toolCallStreak: {},
        toolResults: new Map(),
        overLimitActionCalls: 0,
      },
      abortController: new AbortController(),
      computer: {
        lazy: { throwIfFailed: () => {} },
        checkpoint: { flush: vi.fn() },
      },
      tools: { approvedReplays: { assertDrained: () => {} } },
      source: {},
      secrets: [],
      scripted: true,
    } as unknown as RunContext;
    return ctx;
  }

  it("does not flush progress for a scripted runtime without streamsProgress", async () => {
    const ctx = await streamingContext();
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "text", text: "Hello from script." };
      yield { type: "done", text: "Hello from script." };
    }
    await consumeRunEvents(ctx, runtime());
    expect(flushProgress).not.toHaveBeenCalled();
  });

  it("flushes progress for a scripted runtime when streamsProgress returns true", async () => {
    const ctx = await streamingContext({
      streamsProgress: (id) => id === "edition-mock",
    });
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "text", text: "Hello from edition." };
      yield { type: "done", text: "Hello from edition." };
    }
    await consumeRunEvents(ctx, runtime());
    expect(flushProgress).toHaveBeenCalled();
  });
});
