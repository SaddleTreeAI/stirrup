import { createHash, randomUUID } from "node:crypto";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import { ARTIFACT_NAME_MAX_LENGTH } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

export type EditionFileServices = {
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

type EditionFileDeps = {
  prisma: PrismaClient;
  artifacts: ArtifactStore;
  maxBytes: number;
};

/** Files for editions: store and open space-scoped artifacts without a bot owner. */
export function createEditionFiles(deps: EditionFileDeps): EditionFileServices {
  return {
    maxBytes: deps.maxBytes,
    store: (input) => storeEditionFile(deps, input),
    open: (input) => openEditionFile(deps, input),
  };
}

async function storeEditionFile(
  deps: EditionFileDeps,
  input: {
    spaceId: string;
    userId: string;
    filename: string;
    mediaType: string;
    bytes: Uint8Array;
  },
): Promise<{ artifactId: string; sizeBytes: number; mediaType: string }> {
  if (input.bytes.byteLength > deps.maxBytes) {
    throw new EditionFileTooLargeError(deps.maxBytes);
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

async function openEditionFile(
  deps: EditionFileDeps,
  input: { spaceId: string; artifactId: string },
): Promise<{ stream: ReadableStream<Uint8Array>; size: number; mediaType: string } | null> {
  const row = await deps.prisma.artifact.findFirst({
    where: { id: input.artifactId, spaceId: input.spaceId },
    select: { id: true, storageKey: true, size: true, mimeType: true, userId: true },
  });
  if (!row) return null;
  if (!Number.isSafeInteger(row.size) || row.size < 0) return null;
  const context = createAdapterContext(
    { spaceId: input.spaceId, userId: row.userId },
    "edition-file",
    `edition-file-get:${row.id}`,
  );
  const iterator = deps.artifacts.stream(row.storageKey, context)[Symbol.asyncIterator]();
  let bytesSent = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          if (bytesSent !== row.size) {
            controller.error(new Error("Stored artifact size did not match its metadata"));
            return;
          }
          controller.close();
          return;
        }
        const chunk = next.value;
        if (bytesSent + chunk.byteLength > row.size) {
          await iterator.return?.();
          controller.error(new Error("Stored artifact exceeded its metadata size"));
          return;
        }
        bytesSent += chunk.byteLength;
        controller.enqueue(chunk);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  return { stream, size: row.size, mediaType: row.mimeType };
}

function sanitizeMediaType(value: string): string {
  const mediaType = value.split(";", 1)[0]?.trim() ?? "";
  return /^[\w.+-]+\/[\w.+-]+$/.test(mediaType) ? mediaType : "application/octet-stream";
}

export class EditionFileTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super("File exceeds the upload size limit");
    this.name = "EditionFileTooLargeError";
    this.maxBytes = maxBytes;
  }
}
