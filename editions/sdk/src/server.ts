import type { AgentRuntime } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { Hono } from "hono";

/** Optional file store/open helpers core passes to editions that mount library routes. */
export type EditionFiles = {
  store(input: {
    spaceId: string;
    userId: string;
    filename: string;
    mediaType: string;
    bytes: Uint8Array;
  }): Promise<{ artifactId: string; sizeBytes: number; mediaType: string }>;
  open(input: {
    spaceId: string;
    artifactId: string;
  }): Promise<{ stream: ReadableStream<Uint8Array>; size: number; mediaType: string } | null>;
  maxBytes: number;
};

export type EditionRouteDeps = {
  prisma: PrismaClient;
  sessionActor: (request: Request) => Promise<Actor | null>;
  files?: EditionFiles;
};

/** A tool an edition offers for one bot on one turn. execute closes over that bot's scope. */
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
  /** Extra tools for this bot. Undefined or empty means none. */
  tools?: (
    prisma: PrismaClient,
    botId: string,
    actor: Pick<Actor, "userId" | "spaceId">,
  ) => Promise<EditionTool[] | undefined>;
};

/** Optional veto of access to a bot's thread. Undefined means every bot is allowed. */
export type EditionBotAccess = (
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
) => Promise<"allow" | "deny">;

export type ServerEdition = {
  id: string;
  onProcessStart?: () => void;
  mountRoutes?: (app: Hono, deps: EditionRouteDeps) => void;
  agentRuntime?: () => AgentRuntime | undefined;
  afterBootstrap?: (prisma: PrismaClient) => Promise<void>;
  runHooks?: EditionRunHooks;
  /** Undefined means every bot is allowed. */
  botAccess?: EditionBotAccess;
};

/** Identity helper that fills optional server edition defaults. */
export function defineServerEdition(edition: ServerEdition): ServerEdition {
  return {
    onProcessStart: undefined,
    mountRoutes: undefined,
    agentRuntime: undefined,
    afterBootstrap: undefined,
    runHooks: undefined,
    botAccess: undefined,
    ...edition,
  };
}

/** Pick a registered edition by id, or throw with the known ids. */
export function resolveEdition<T extends { id: string }>(
  id: string,
  registry: Readonly<Record<string, T>>,
): T {
  const edition = registry[id];
  if (!edition) {
    const known = Object.keys(registry).sort().join(", ");
    throw new Error(`Unknown edition "${id}". Known editions: ${known || "(none)"}`);
  }
  return edition;
}
