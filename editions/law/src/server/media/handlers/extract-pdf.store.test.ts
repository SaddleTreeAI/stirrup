// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

/**
 * Upload-shaped fixture → extract_pdf through createHandlerIo.
 * Catches the storageKey vs artifact-row-id ENOENT that unit-handler mocks miss.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAdapterContext } from "@rakazo/adapter-kit";
import { LocalArtifactStore } from "@rakazo/adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandlerIo } from "../store.js";
import type { HandlerContext, LawJobRow, Runner, RunResult } from "../types.js";
import { extractPdfHandler } from "./extract-pdf.js";

vi.mock("../../seal.js", () => ({
  sealLawText: vi.fn(
    async (_prisma: unknown, _loc: unknown, plaintext: string) => `sealed:${plaintext}`,
  ),
}));

type ArtifactRow = {
  id: string;
  spaceId: string;
  userId: string;
  storageKey: string;
  name: string;
  mimeType: string;
  size: number;
  hash: string;
};

type DocUpdate = {
  status?: string;
  statusDetail?: string;
  pageCount?: number;
  body?: string;
};

function job(documentId: string): LawJobRow {
  const now = new Date();
  return {
    id: "job-extract",
    caseId: "case-1",
    documentId,
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

function makeRunner(
  handlers: Record<string, (args: string[], cwd?: string) => Promise<RunResult> | RunResult>,
): Runner {
  return {
    async run(cmd, args, options) {
      const handler = handlers[cmd];
      if (!handler) return { code: 1, stdout: "", stderr: `unknown ${cmd}` };
      return handler(args, options?.cwd);
    },
  };
}

describe("extract_pdf via library-shaped artifact store", () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uploads a PDF artifact, runs extract_pdf, and leaves ready page rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "law-pdf-upload-"));
    dirs.push(root);
    const store = new LocalArtifactStore(root);
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 library-upload-fixture");
    const putContext = createAdapterContext(
      { spaceId: "space-1", userId: "user-1" },
      "edition-file",
      "upload",
    );
    const put = await store.put(
      { name: "complaint.pdf", mimeType: "application/pdf", bytes: pdfBytes },
      putContext,
    );
    // Library route stores the row id on law_documents.artifactId (not put.id).
    const artifactId = randomUUID();
    const artifacts = new Map<string, ArtifactRow>([
      [
        artifactId,
        {
          id: artifactId,
          spaceId: "space-1",
          userId: "user-1",
          storageKey: put.id,
          name: "complaint.pdf",
          mimeType: "application/pdf",
          size: pdfBytes.byteLength,
          hash: createHash("sha256").update(pdfBytes).digest("hex"),
        },
      ],
    ]);
    expect(artifactId).not.toBe(put.id);

    const documentId = randomUUID();
    const updates: DocUpdate[] = [];
    const createdPages: Array<{ page: number; text: string; ocr: boolean }> = [];
    const prisma = {
      lawCase: {
        findUnique: async () => ({ spaceId: "space-1" }),
      },
      lawDocument: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          if (where.id !== documentId) return null;
          return {
            id: documentId,
            caseId: "case-1",
            artifactId,
            filename: "complaint.pdf",
          };
        },
        update: async ({ data }: { data: DocUpdate }) => {
          updates.push(data);
          return data;
        },
      },
      lawDocumentPage: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({
          data,
        }: {
          data: Array<{ page: number; text: string; ocr: boolean }>;
        }) => {
          createdPages.push(...data);
          return { count: data.length };
        },
      },
      lawJob: {
        findFirst: async () => null,
        create: async () => ({ id: "job-ocr" }),
      },
      artifact: {
        findFirst: async ({ where }: { where: { id: string; spaceId: string } }) => {
          const row = artifacts.get(where.id);
          if (!row || row.spaceId !== where.spaceId) return null;
          return { id: row.id, storageKey: row.storageKey, userId: row.userId };
        },
        create: async ({ data }: { data: ArtifactRow; select: { id: true } }) => {
          const id = data.id ?? randomUUID();
          artifacts.set(id, { ...data, id });
          return { id };
        },
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    };

    const tmpDir = await mkdtemp(path.join(root, "job-"));
    const io = createHandlerIo(
      { prisma: prisma as never, artifacts: store },
      { job: job(documentId), tmpDir },
    );
    const runner = makeRunner({
      pdfinfo: () => ({ code: 0, stdout: "Pages: 2\nEncrypted: no\n", stderr: "" }),
      pdftotext: async (args, cwd) => {
        const out = args[args.length - 1]!;
        const target = path.isAbsolute(out) ? out : path.join(cwd ?? "", out);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(
          target,
          "page one has enough non-whitespace characters for the extract\fpage two caffeine and more words for coverage",
        );
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const ctx: HandlerContext = {
      job: job(documentId),
      prisma: prisma as never,
      runner,
      tmpDir,
      readOriginal: io.readOriginal,
      saveArtifact: io.saveArtifact,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };

    await extractPdfHandler(ctx);

    const ready = updates.find((row) => row.status === "ready");
    expect(ready).toMatchObject({ status: "ready", pageCount: 2, statusDetail: "" });
    expect(createdPages).toHaveLength(2);
    expect(createdPages.map((row) => row.page)).toEqual([1, 2]);
    expect(createdPages[0]?.text).toContain("sealed:");
    expect(createdPages.every((row) => row.ocr === false)).toBe(true);
  });
});
