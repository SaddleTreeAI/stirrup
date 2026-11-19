// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { PrismaClient } from "@rakazo/db";
import { enqueueLawJob } from "./media/enqueue.js";

/**
 * Queue text/OCR extraction for an uploaded document. L0 owns the full ingest
 * path; M0 only provides the enqueue seam used here.
 */
export async function enqueueExtraction(
  prisma: PrismaClient,
  input: {
    caseId: string;
    documentId: string;
    kind?: string;
    payload?: unknown;
  },
) {
  return enqueueLawJob(prisma, {
    caseId: input.caseId,
    documentId: input.documentId,
    kind: input.kind ?? "extract",
    payload: input.payload,
  });
}
