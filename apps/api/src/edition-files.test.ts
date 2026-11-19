import { describe, expect, it, vi } from "vitest";
import { createEditionFiles, EditionFileTooLargeError } from "./edition-files.js";

function fakeArtifacts() {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    put: vi.fn(async (artifact: { bytes: Uint8Array }) => {
      const id = `storage-${blobs.size + 1}`;
      blobs.set(id, artifact.bytes);
      return { id, hash: "hash" };
    }),
    get: vi.fn(async (id: string) => blobs.get(id) ?? new Uint8Array()),
    stream: vi.fn(async function* (id: string) {
      const bytes = blobs.get(id);
      if (bytes) yield bytes;
    }),
    remove: vi.fn(async (id: string) => {
      blobs.delete(id);
    }),
    describe: () => ({
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { stream: true },
    }),
  };
}

describe("createEditionFiles", () => {
  it("stores bytes as a standalone artifact and opens a stream", async () => {
    const artifacts = fakeArtifacts();
    const created: Record<string, unknown> = {};
    const prisma = {
      artifact: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(created, data, { id: "artifact-1" });
          return { id: "artifact-1", size: data.size, mimeType: data.mimeType };
        }),
        findFirst: vi.fn(async () => ({
          id: "artifact-1",
          storageKey: created.storageKey,
          size: 5,
          mimeType: "text/plain",
          userId: "user-1",
        })),
      },
    };
    const files = createEditionFiles({
      prisma: prisma as never,
      artifacts: artifacts as never,
      maxBytes: 1024,
    });
    expect(files.maxBytes).toBe(1024);

    const stored = await files.store({
      spaceId: "space-1",
      userId: "user-1",
      filename: "note.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("hello"),
    });
    expect(stored).toEqual({
      artifactId: "artifact-1",
      sizeBytes: 5,
      mediaType: "text/plain",
    });
    expect(prisma.artifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          standalone: true,
          botId: null,
          size: 5,
        }),
      }),
    );

    const opened = await files.open({ spaceId: "space-1", artifactId: "artifact-1" });
    expect(opened).not.toBeNull();
    expect(opened?.size).toBe(5);
    expect(opened?.mediaType).toBe("text/plain");
    const reader = opened!.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe("hello");
  });

  it("rejects oversized uploads before writing storage", async () => {
    const artifacts = fakeArtifacts();
    const prisma = { artifact: { create: vi.fn() } };
    const files = createEditionFiles({
      prisma: prisma as never,
      artifacts: artifacts as never,
      maxBytes: 4,
    });
    await expect(
      files.store({
        spaceId: "space-1",
        userId: "user-1",
        filename: "big.bin",
        mediaType: "application/octet-stream",
        bytes: new Uint8Array(5),
      }),
    ).rejects.toBeInstanceOf(EditionFileTooLargeError);
    expect(artifacts.put).not.toHaveBeenCalled();
  });

  it("returns null when the artifact is missing", async () => {
    const files = createEditionFiles({
      prisma: { artifact: { findFirst: vi.fn(async () => null) } } as never,
      artifacts: fakeArtifacts() as never,
      maxBytes: 10,
    });
    await expect(files.open({ spaceId: "space-1", artifactId: "missing" })).resolves.toBeNull();
  });
});
