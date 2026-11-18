import type { PrismaClient } from "@rakazo/db";

// Keep structurally identical to EditionRunHooks in editions/sdk/src/server.ts.
export type EditionRunHooks = {
  turnNote?: (
    prisma: PrismaClient,
    botId: string,
    basePrompt: string,
  ) => Promise<string | undefined>;
  limitTeammates?: <T extends { id: string }>(
    prisma: PrismaClient,
    botId: string,
    teammates: T[],
  ) => Promise<T[]>;
  onReplyFinalized?: (
    prisma: PrismaClient,
    input: { botId: string; runId: string; text: string },
  ) => Promise<void>;
  streamsProgress?: (runtimeId: string | undefined) => boolean;
};
