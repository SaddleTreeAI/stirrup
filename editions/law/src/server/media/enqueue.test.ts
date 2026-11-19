// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { describe, expect, it, vi } from "vitest";
import { enqueueLawJob } from "./enqueue.js";

type JobRow = {
  id: string;
  documentId: string | null;
  kind: string;
  status: string;
  caseId: string;
  createdAt: Date;
};

type FakeTx = {
  lawJob: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  $transaction: <T>(fn: (tx: FakeTx) => Promise<T>) => Promise<T>;
};

function fakePrisma(seed: JobRow[] = []) {
  const rows = [...seed];
  const api: FakeTx = {
    lawJob: {
      findFirst: vi.fn(
        async (args: { where: { documentId: string; kind: string; status: { in: string[] } } }) => {
          const match = rows.find(
            (row) =>
              row.documentId === args.where.documentId &&
              row.kind === args.where.kind &&
              args.where.status.in.includes(row.status),
          );
          return match ? { id: match.id } : null;
        },
      ),
      create: vi.fn(
        async (args: {
          data: Omit<JobRow, "id" | "createdAt"> & { payload?: unknown };
          select: { id: true };
        }) => {
          const row: JobRow = {
            id: `job-${rows.length + 1}`,
            documentId: args.data.documentId,
            kind: args.data.kind,
            status: args.data.status,
            caseId: args.data.caseId,
            createdAt: new Date(),
          };
          rows.push(row);
          return { id: row.id };
        },
      ),
    },
    $transaction: async <T>(fn: (tx: FakeTx) => Promise<T>) => fn(api),
  };
  return { prisma: api as never, rows };
}

describe("enqueueLawJob", () => {
  it("creates a queued job", async () => {
    const { prisma, rows } = fakePrisma();
    const result = await enqueueLawJob(prisma, {
      caseId: "case-1",
      documentId: "doc-1",
      kind: "selftest",
      payload: { n: 1 },
    });
    expect(result.created).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("selftest");
  });

  it("is idempotent while queued or running for the same documentId+kind", async () => {
    const { prisma, rows } = fakePrisma([
      {
        id: "existing",
        caseId: "case-1",
        documentId: "doc-1",
        kind: "extract",
        status: "running",
        createdAt: new Date(),
      },
    ]);
    const result = await enqueueLawJob(prisma, {
      caseId: "case-1",
      documentId: "doc-1",
      kind: "extract",
    });
    expect(result).toEqual({ id: "existing", created: false });
    expect(rows).toHaveLength(1);
  });

  it("enqueues again after the prior job finished", async () => {
    const { prisma, rows } = fakePrisma([
      {
        id: "done",
        caseId: "case-1",
        documentId: "doc-1",
        kind: "extract",
        status: "done",
        createdAt: new Date(),
      },
    ]);
    const result = await enqueueLawJob(prisma, {
      caseId: "case-1",
      documentId: "doc-1",
      kind: "extract",
    });
    expect(result.created).toBe(true);
    expect(rows).toHaveLength(2);
  });
});
