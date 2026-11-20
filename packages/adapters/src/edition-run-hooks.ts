import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

// Keep structurally identical to EditionRunHooks in editions/sdk/src/server.ts.
export type EditionTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

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
  tools?: (
    prisma: PrismaClient,
    botId: string,
    actor: Pick<Actor, "userId" | "spaceId">,
  ) => Promise<EditionTool[] | undefined>;
};
