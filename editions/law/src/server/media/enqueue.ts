// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { PrismaClient } from "@rakazo/db";

export type EnqueueLawJobInput = {
  caseId: string;
  documentId: string;
  kind: string;
  payload?: unknown;
  maxAttempts?: number;
  runAfter?: Date;
};

export type EnqueueLawJobResult = {
  id: string;
  created: boolean;
};

/**
 * Enqueue a media job. Idempotent per (documentId, kind) while a row is still
 * queued or running (DB1 has no partial unique index, so this is checked in a
 * transaction).
 */
export async function enqueueLawJob(
  prisma: PrismaClient,
  input: EnqueueLawJobInput,
): Promise<EnqueueLawJobResult> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.lawJob.findFirst({
      where: {
        documentId: input.documentId,
        kind: input.kind,
        status: { in: ["queued", "running"] },
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    if (existing) return { id: existing.id, created: false };

    const created = await tx.lawJob.create({
      data: {
        caseId: input.caseId,
        documentId: input.documentId,
        kind: input.kind,
        status: "queued",
        payload: (input.payload ?? {}) as object,
        maxAttempts: input.maxAttempts ?? 3,
        runAfter: input.runAfter ?? new Date(),
      },
      select: { id: true },
    });
    return { id: created.id, created: true };
  });
}
