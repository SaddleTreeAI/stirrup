// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { createHash, randomUUID } from "node:crypto";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import { ARTIFACT_NAME_MAX_LENGTH } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

export type EditionArtifactStoreDeps = {
  prisma: PrismaClient;
  artifacts: ArtifactStore;
  maxBytes: number;
};

/** Store bytes as a space-scoped artifact with no bot owner (edition libraries). */
export async function storeEditionArtifact(
  deps: EditionArtifactStoreDeps,
  input: {
    spaceId: string;
    userId: string;
    filename: string;
    mediaType: string;
    bytes: Uint8Array;
  },
): Promise<{ artifactId: string; sizeBytes: number; mediaType: string }> {
  if (input.bytes.byteLength > deps.maxBytes) {
    throw new EditionArtifactTooLargeError(deps.maxBytes);
  }
  const name = input.filename.slice(0, ARTIFACT_NAME_MAX_LENGTH) || "upload";
  const mediaType = sanitizeMediaType(input.mediaType);
  const actor = { spaceId: input.spaceId, userId: input.userId };
  const context = createAdapterContext(actor, "edition-file", `edition-file-put:${randomUUID()}`);
  const stored = await deps.artifacts.put(
    { name, mimeType: mediaType, bytes: input.bytes },
    context,
  );
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  try {
    const row = await deps.prisma.artifact.create({
      data: {
        spaceId: input.spaceId,
        userId: input.userId,
        botId: null,
        name,
        mimeType: mediaType,
        size: input.bytes.byteLength,
        hash,
        storageKey: stored.id,
        rootArtifactId: null,
        version: 1,
        standalone: true,
      },
      select: { id: true, size: true, mimeType: true },
    });
    return { artifactId: row.id, sizeBytes: row.size, mediaType: row.mimeType };
  } catch (error) {
    await bestEffort(
      "remove orphaned edition file bytes",
      deps.artifacts.remove(stored.id, context),
    );
    throw error;
  }
}

export class EditionArtifactTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super("File exceeds the upload size limit");
    this.name = "EditionArtifactTooLargeError";
    this.maxBytes = maxBytes;
  }
}

function sanitizeMediaType(value: string): string {
  const mediaType = value.split(";", 1)[0]?.trim() ?? "";
  return /^[\w.+-]+\/[\w.+-]+$/.test(mediaType) ? mediaType : "application/octet-stream";
}
