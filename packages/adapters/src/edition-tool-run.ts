// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { resolveBotWorkspacePath } from "./computer-support.js";
import { storeEditionArtifact } from "./edition-artifacts.js";
import type { EditionToolRun } from "./edition-run-hooks.js";
import type { RunContext } from "./run-context.js";

/** Build the R5 run bag for an edition tool call (computer read + artifact store). */
export function editionToolRun(ctx: RunContext, toolName: string): EditionToolRun {
  const { deps, bot, run, context } = ctx;
  const maxBytes = deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES;
  return {
    maxBytes,
    async readComputerFile(filePath) {
      if (!deps.artifacts) throw new Error("artifact storage unavailable");
      return deps.sandbox.readFile(
        await ctx.computer.get("tool", toolName),
        resolveBotWorkspacePath(ctx.computer.mode, bot.id, filePath),
        context,
        { maxBytes },
      );
    },
    async storeFile(input) {
      if (!deps.artifacts) throw new Error("artifact storage unavailable");
      return storeEditionArtifact(
        { prisma: deps.prisma, artifacts: deps.artifacts, maxBytes },
        {
          spaceId: run.spaceId,
          userId: run.userId,
          filename: input.filename,
          mediaType: input.mediaType,
          bytes: input.bytes,
        },
      );
    },
  };
}
