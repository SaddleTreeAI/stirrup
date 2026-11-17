import type {
  PlatformAdminBotInspection,
  PlatformAdminBotSummary,
  PlatformAdminCursor,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { runAsSystem, storedMessageBlocks } from "@rakazo/db";
import { authorizePlatformInspection } from "./platform-admin.js";
import type { RouterDeps } from "./router.js";

const INSPECTION_PAGE_SIZE = 50;

type AdminBotPrisma = Pick<
  PrismaClient,
  | "bot"
  | "space"
  | "user"
  | "thread"
  | "chatGroup"
  | "message"
  | "memoryDocument"
  | "artifact"
  | "usageRecord"
  | "platformInvite"
  | "deploymentSettings"
  | "$transaction"
>;

async function botSummary(
  prisma: AdminBotPrisma,
  botId: string,
): Promise<PlatformAdminBotSummary | null> {
  return runAsSystem("read a bot summary for platform oversight", async () => {
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      select: {
        id: true,
        spaceId: true,
        name: true,
        userId: true,
        createdAt: true,
        updatedAt: true,
        space: { select: { name: true } },
      },
    });
    if (!bot) return null;
    const user = await prisma.user.findUnique({
      where: { id: bot.userId },
      select: { id: true, name: true, email: true },
    });
    if (!user) return null;
    return {
      id: bot.id,
      spaceId: bot.spaceId,
      spaceName: bot.space.name,
      name: bot.name,
      ownerUserId: user.id,
      ownerName: user.name,
      ownerEmail: user.email,
      createdAt: bot.createdAt.toISOString(),
      updatedAt: bot.updatedAt.toISOString(),
    };
  });
}

export async function listPlatformUserBots(
  prisma: AdminBotPrisma,
  actorUserId: string,
  targetUserId: string,
): Promise<PlatformAdminBotSummary[]> {
  await authorizePlatformInspection(prisma, actorUserId, targetUserId, "bot-content");
  const botIds = await runAsSystem("list a platform user's bots for oversight", () =>
    prisma.bot.findMany({
      where: { userId: targetUserId },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
    }),
  );
  const summaries = await Promise.all(botIds.map(({ id }) => botSummary(prisma, id)));
  return summaries.filter((summary): summary is PlatformAdminBotSummary => summary !== null);
}

export async function inspectPlatformBot(
  prisma: AdminBotPrisma,
  actorUserId: string,
  botId: string,
  input: {
    threadId?: string;
    threadsBefore?: PlatformAdminCursor;
    before?: PlatformAdminCursor;
    memoriesBefore?: PlatformAdminCursor;
    filesBefore?: PlatformAdminCursor;
    usageBefore?: PlatformAdminCursor;
  } = {},
): Promise<PlatformAdminBotInspection> {
  const bot = await runAsSystem("resolve a bot target for platform oversight", () =>
    prisma.bot.findUnique({
      where: { id: botId },
      select: {
        id: true,
        spaceId: true,
        userId: true,
        name: true,
        description: true,
        instructions: true,
        modelProvider: true,
        modelId: true,
        archivedAt: true,
      },
    }),
  );
  if (!bot) throw new ClientError("NOT_FOUND", "Bot not found");
  await authorizePlatformInspection(prisma, actorUserId, bot.userId, "bot-content");
  const summary = await botSummary(prisma, botId);
  if (!summary) throw new ClientError("NOT_FOUND", "Bot not found");

  const result = await runAsSystem(
    "inspect bounded bot content for platform oversight",
    async () => {
      const threadScope: Prisma.ThreadWhereInput = {
        OR: [{ botId }, { helperBotId: botId }, { group: { members: { some: { botId } } } }],
      };
      const threadCursor: Prisma.ThreadWhereInput = input.threadsBefore
        ? {
            OR: [
              { createdAt: { lt: new Date(input.threadsBefore.createdAt) } },
              {
                createdAt: new Date(input.threadsBefore.createdAt),
                id: { lt: input.threadsBefore.id },
              },
            ],
          }
        : {};
      const threads = await prisma.thread.findMany({
        where: { AND: [threadScope, threadCursor] },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: INSPECTION_PAGE_SIZE + 1,
        select: {
          id: true,
          createdAt: true,
          groupId: true,
          helperBotId: true,
          group: { select: { name: true } },
          helperBot: { select: { name: true } },
        },
      });
      let selectedThreadId = input.threadId ?? threads[0]?.id ?? null;
      if (input.threadId) {
        const selected = await prisma.thread.findFirst({
          where: { id: input.threadId, ...threadScope },
          select: { id: true },
        });
        if (!selected) throw new ClientError("NOT_FOUND", "Conversation not found for this bot");
        selectedThreadId = selected.id;
      }
      const threadPage = threads.slice(0, INSPECTION_PAGE_SIZE);
      const messagesPromise = selectedThreadId
        ? prisma.message.findMany({
            where: {
              threadId: selectedThreadId,
              ...(input.before
                ? {
                    OR: [
                      { createdAt: { lt: new Date(input.before.createdAt) } },
                      {
                        createdAt: new Date(input.before.createdAt),
                        id: { lt: input.before.id },
                      },
                    ],
                  }
                : {}),
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: INSPECTION_PAGE_SIZE + 1,
            select: {
              id: true,
              threadId: true,
              seq: true,
              role: true,
              authorUserId: true,
              blocks: true,
              createdAt: true,
            },
          })
        : Promise.resolve([]);
      const memoriesPromise = prisma.memoryDocument.findMany({
        where: {
          botId,
          ...(input.memoriesBefore
            ? {
                OR: [
                  { updatedAt: { lt: new Date(input.memoriesBefore.createdAt) } },
                  {
                    updatedAt: new Date(input.memoriesBefore.createdAt),
                    id: { lt: input.memoriesBefore.id },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: INSPECTION_PAGE_SIZE + 1,
        select: {
          id: true,
          scope: true,
          path: true,
          content: true,
          revision: true,
          updatedAt: true,
        },
      });
      const artifactsPromise = prisma.artifact.findMany({
        where: {
          OR: [{ botId }, { group: { members: { some: { botId } } } }],
          ...(input.filesBefore
            ? {
                AND: [
                  {
                    OR: [
                      { createdAt: { lt: new Date(input.filesBefore.createdAt) } },
                      {
                        createdAt: new Date(input.filesBefore.createdAt),
                        id: { lt: input.filesBefore.id },
                      },
                    ],
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: INSPECTION_PAGE_SIZE + 1,
        select: {
          id: true,
          name: true,
          description: true,
          mimeType: true,
          size: true,
          createdAt: true,
        },
      });
      const usagePromise = prisma.usageRecord.findMany({
        where: {
          botId,
          ...(input.usageBefore
            ? {
                OR: [
                  { createdAt: { lt: new Date(input.usageBefore.createdAt) } },
                  {
                    createdAt: new Date(input.usageBefore.createdAt),
                    id: { lt: input.usageBefore.id },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: INSPECTION_PAGE_SIZE + 1,
        select: {
          id: true,
          provider: true,
          model: true,
          inputTokens: true,
          outputTokens: true,
          costUsd: true,
          createdAt: true,
        },
      });
      const [rows, memories, artifacts, usage] = await Promise.all([
        messagesPromise,
        memoriesPromise,
        artifactsPromise,
        usagePromise,
      ]);
      const messageRows = rows.slice(0, INSPECTION_PAGE_SIZE);
      const memoryRows = memories.slice(0, INSPECTION_PAGE_SIZE);
      const fileRows = artifacts.slice(0, INSPECTION_PAGE_SIZE);
      const usageRows = usage.slice(0, INSPECTION_PAGE_SIZE);
      const cursorOf = (createdAt: Date, id: string): PlatformAdminCursor => ({
        createdAt: createdAt.toISOString(),
        id,
      });
      return {
        threads: threadPage.map((thread) => ({
          id: thread.id,
          label: thread.group?.name ?? thread.helperBot?.name ?? bot.name,
          kind: thread.groupId
            ? ("group" as const)
            : thread.helperBotId
              ? ("helper" as const)
              : ("bot" as const),
          createdAt: thread.createdAt.toISOString(),
        })),
        selectedThreadId,
        nextThreadsBefore:
          threads.length > INSPECTION_PAGE_SIZE && threadPage.length
            ? cursorOf(
                threadPage[threadPage.length - 1]!.createdAt,
                threadPage[threadPage.length - 1]!.id,
              )
            : null,
        messages: messageRows
          .slice()
          .reverse()
          .map((row) => ({
            id: row.id,
            threadId: row.threadId,
            seq: row.seq,
            role: row.role,
            authorUserId: row.authorUserId,
            blocks: storedMessageBlocks(row),
            createdAt: row.createdAt.toISOString(),
          })),
        nextBefore:
          rows.length > INSPECTION_PAGE_SIZE && messageRows.length
            ? cursorOf(
                messageRows[messageRows.length - 1]!.createdAt,
                messageRows[messageRows.length - 1]!.id,
              )
            : null,
        memories: memoryRows.flatMap((row) =>
          row.scope === "bot" || row.scope === "user"
            ? [
                {
                  ...row,
                  scope: row.scope === "bot" ? ("bot" as const) : ("user" as const),
                  updatedAt: row.updatedAt.toISOString(),
                },
              ]
            : [],
        ),
        nextMemoriesBefore:
          memories.length > INSPECTION_PAGE_SIZE && memoryRows.length
            ? cursorOf(
                memoryRows[memoryRows.length - 1]!.updatedAt,
                memoryRows[memoryRows.length - 1]!.id,
              )
            : null,
        files: fileRows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
        nextFilesBefore:
          artifacts.length > INSPECTION_PAGE_SIZE && fileRows.length
            ? cursorOf(fileRows[fileRows.length - 1]!.createdAt, fileRows[fileRows.length - 1]!.id)
            : null,
        usage: usageRows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
        nextUsageBefore:
          usage.length > INSPECTION_PAGE_SIZE && usageRows.length
            ? cursorOf(
                usageRows[usageRows.length - 1]!.createdAt,
                usageRows[usageRows.length - 1]!.id,
              )
            : null,
      };
    },
  );
  return {
    bot: {
      ...summary,
      description: bot.description,
      instructions: bot.instructions,
      modelProvider: bot.modelProvider,
      modelId: bot.modelId,
      archivedAt: bot.archivedAt?.toISOString() ?? null,
    },
    ...result,
  };
}

export async function resolvePlatformBotFile(
  deps: Pick<RouterDeps, "prisma">,
  actorUserId: string,
  botId: string,
  artifactId: string,
) {
  const bot = await runAsSystem("resolve a bot for platform file oversight", () =>
    deps.prisma.bot.findUnique({
      where: { id: botId },
      select: { id: true, userId: true, spaceId: true },
    }),
  );
  if (!bot) throw new ClientError("NOT_FOUND", "Bot file not found");
  await authorizePlatformInspection(deps.prisma, actorUserId, bot.userId, "bot-content");
  const file = await runAsSystem("resolve a file for platform bot oversight", async () => {
    const row = await deps.prisma.artifact.findUnique({
      where: { id: artifactId },
      select: {
        id: true,
        botId: true,
        groupId: true,
        spaceId: true,
        userId: true,
        name: true,
        mimeType: true,
        size: true,
        storageKey: true,
      },
    });
    if (!row || row.spaceId !== bot.spaceId) return null;
    if (row.botId === botId) return row;
    if (!row.groupId) return null;
    const group = await deps.prisma.chatGroup.findFirst({
      where: { id: row.groupId, spaceId: bot.spaceId, members: { some: { botId } } },
      select: { id: true },
    });
    return group ? row : null;
  });
  if (!file) throw new ClientError("NOT_FOUND", "Bot file not found");
  return { file, botId, spaceId: bot.spaceId };
}
