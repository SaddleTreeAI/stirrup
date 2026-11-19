// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

// Env names mirror apps/api/src/env.ts (dataDir) and apps/api/src/app.ts
// (createArtifactStore). Do not import apps/*.

import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import { createArtifactStore } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import type { LawJobRow } from "./types.js";

export type MediaStoreEnv = {
  dataDir: string;
};

/** Parse the artifact-related env the api uses (DATA_DIR; object storage via process.env). */
export function mediaStoreEnvFromProcess(env: NodeJS.ProcessEnv = process.env): MediaStoreEnv {
  return {
    dataDir: env.DATA_DIR?.trim() || "./data",
  };
}

export function createMediaArtifactStore(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): ArtifactStore {
  const { dataDir } = mediaStoreEnvFromProcess(env);
  return createArtifactStore(dataDir, prisma, env);
}

export type HandlerIoDeps = {
  prisma: PrismaClient;
  artifacts: ArtifactStore;
  /** Fallback space when the case row is missing (tests). */
  spaceIdForCase?: (caseId: string) => Promise<string>;
};

/**
 * Build readOriginal / saveArtifact for one job. Originals are decrypted into
 * the job temp directory; plaintext bytes never leave that path except via
 * saveArtifact into the shared store.
 */
export function createHandlerIo(
  deps: HandlerIoDeps,
  input: { job: LawJobRow; tmpDir: string },
): {
  readOriginal: (documentId: string) => Promise<string>;
  saveArtifact: (args: {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    spaceId: string;
    userId?: string;
  }) => Promise<{ id: string }>;
} {
  const resolveSpaceId = async (caseId: string): Promise<string> => {
    if (deps.spaceIdForCase) return deps.spaceIdForCase(caseId);
    const row = await deps.prisma.lawCase.findUnique({
      where: { id: caseId },
      select: { spaceId: true },
    });
    if (!row) throw new Error("case not found");
    return row.spaceId;
  };

  return {
    async readOriginal(documentId) {
      const doc = await deps.prisma.lawDocument.findUnique({
        where: { id: documentId },
        select: { artifactId: true, caseId: true, filename: true },
      });
      if (!doc?.artifactId) throw new Error("original missing");
      const spaceId = await resolveSpaceId(doc.caseId);
      const context = createAdapterContext(
        { spaceId, userId: "media-sidecar" },
        "media",
        `read-${documentId}`,
      );
      const bytes = await deps.artifacts.get(doc.artifactId, context);
      const dir = await mkdtemp(path.join(input.tmpDir, "orig-"));
      const safeName = (doc.filename || "original").replace(/[/\\]/g, "_").slice(0, 120);
      const target = path.join(dir, safeName || "original");
      await writeFile(target, bytes);
      return target;
    },

    async saveArtifact(args) {
      const context = createAdapterContext(
        { spaceId: args.spaceId, userId: args.userId ?? "media-sidecar" },
        "media",
        `save-${randomSuffix()}`,
      );
      const put = await deps.artifacts.put(
        { name: args.name, mimeType: args.mimeType, bytes: args.bytes },
        context,
      );
      return { id: put.id };
    },
  };
}

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Write a stream to a path under tmpDir (helpers for later extract handlers). */
export async function writeStreamToTemp(
  tmpDir: string,
  name: string,
  body: AsyncIterable<Uint8Array> | Uint8Array,
): Promise<string> {
  await mkdir(tmpDir, { recursive: true });
  const target = path.join(tmpDir, name.replace(/[/\\]/g, "_"));
  if (body instanceof Uint8Array) {
    await writeFile(target, body);
    return target;
  }
  await pipeline(Readable.from(body), createWriteStream(target));
  return target;
}
