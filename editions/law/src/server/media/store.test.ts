// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAdapterContext } from "@rakazo/adapter-kit";
import { LocalArtifactStore } from "@rakazo/adapters";
import { afterEach, describe, expect, it } from "vitest";
import { createHandlerIo } from "./store.js";
import type { LawJobRow } from "./types.js";

type ArtifactRow = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string | null;
  name: string;
  mimeType: string;
  size: number;
  hash: string;
  storageKey: string;
  rootArtifactId: string | null;
  version: number;
  standalone: boolean;
};

function job(): LawJobRow {
  const now = new Date();
  return {
    id: "job-1",
    caseId: "case-1",
    documentId: "doc-1",
    kind: "extract_pdf",
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    error: "",
    payload: {},
    runAfter: now,
    lockedAt: now,
    lockedBy: "w1",
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  };
}

function makePrisma(options: { artifactId: string | null; artifacts: Map<string, ArtifactRow> }) {
  return {
    lawCase: {
      findUnique: async () => ({ spaceId: "space-1" }),
    },
    lawDocument: {
      findUnique: async () => ({
        artifactId: options.artifactId,
        caseId: "case-1",
        filename: "complaint.pdf",
      }),
    },
    artifact: {
      findFirst: async ({ where }: { where: { id: string; spaceId: string } }) => {
        const row = options.artifacts.get(where.id);
        if (!row || row.spaceId !== where.spaceId) return null;
        return { id: row.id, storageKey: row.storageKey, userId: row.userId };
      },
      create: async ({
        data,
      }: {
        data: Omit<ArtifactRow, "id"> & { id?: string };
        select: { id: true };
      }) => {
        const id = data.id ?? randomUUID();
        const row: ArtifactRow = { id, ...data };
        options.artifacts.set(id, row);
        return { id };
      },
    },
  };
}

describe("createHandlerIo artifact keys", () => {
  let root = "";
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads the original via storageKey, not the artifact row id", async () => {
    root = await mkdtemp(path.join(tmpdir(), "law-store-"));
    dirs.push(root);
    const artifacts = new LocalArtifactStore(root);
    const bytes = new TextEncoder().encode("%PDF-1.4 storage-key-fixture");
    const context = createAdapterContext({ spaceId: "space-1", userId: "user-1" }, "media", "seed");
    const put = await artifacts.put(
      { name: "complaint.pdf", mimeType: "application/pdf", bytes },
      context,
    );
    const artifactId = "artifact-row-id";
    expect(put.id).not.toBe(artifactId);
    const rows = new Map<string, ArtifactRow>([
      [
        artifactId,
        {
          id: artifactId,
          spaceId: "space-1",
          userId: "user-1",
          botId: null,
          name: "complaint.pdf",
          mimeType: "application/pdf",
          size: bytes.byteLength,
          hash: createHash("sha256").update(bytes).digest("hex"),
          storageKey: put.id,
          rootArtifactId: null,
          version: 1,
          standalone: true,
        },
      ],
    ]);
    const tmpDir = await mkdtemp(path.join(root, "job-"));
    const io = createHandlerIo(
      {
        prisma: makePrisma({ artifactId, artifacts: rows }) as never,
        artifacts,
      },
      { job: job(), tmpDir },
    );
    const original = await io.readOriginal("doc-1");
    expect(await readFile(original, "utf8")).toBe("%PDF-1.4 storage-key-fixture");
  });

  it("saveArtifact creates an artifact row and returns the row id, not the storage key", async () => {
    root = await mkdtemp(path.join(tmpdir(), "law-store-save-"));
    dirs.push(root);
    const artifacts = new LocalArtifactStore(root);
    const rows = new Map<string, ArtifactRow>();
    const tmpDir = await mkdtemp(path.join(root, "job-"));
    const io = createHandlerIo(
      {
        prisma: makePrisma({ artifactId: null, artifacts: rows }) as never,
        artifacts,
      },
      { job: job(), tmpDir },
    );
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const saved = await io.saveArtifact({
      name: "frame.png",
      mimeType: "image/png",
      bytes,
      spaceId: "space-1",
      userId: "user-1",
    });
    expect(rows.has(saved.id)).toBe(true);
    const row = rows.get(saved.id)!;
    expect(row.storageKey).not.toBe(saved.id);
    const context = createAdapterContext(
      { spaceId: "space-1", userId: "user-1" },
      "media",
      "verify",
    );
    expect(await artifacts.get(row.storageKey, context)).toEqual(bytes);
  });
});
