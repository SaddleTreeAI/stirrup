// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { EditionFiles } from "@rakazo/edition-sdk";
import { classify, enqueueExtraction, prepareIngestBody } from "./ingest.js";
import { sealLawText } from "./seal.js";

const TITLE_MAX = 200;
const FILENAME_MAX = 200;

export type LibraryUploadInput = {
  caseId: string;
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
  titleOverride?: string;
};

/** Store bytes as a case library upload and enqueue extraction when needed. */
export async function uploadLibraryDocument(
  prisma: PrismaClient,
  files: Pick<EditionFiles, "store">,
  actor: Actor,
  input: LibraryUploadInput,
) {
  if (!(await requireMember(prisma, actor.userId, input.caseId))) return "forbidden";

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const duplicate = await prisma.lawDocument.findFirst({
    where: {
      caseId: input.caseId,
      sha256,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (duplicate) return { conflict: true as const, existingId: duplicate.id };

  const stored = await files.store({
    spaceId: actor.spaceId,
    userId: actor.userId,
    filename: input.filename,
    mediaType: input.mediaType,
    bytes: input.bytes,
  });

  const classification = classify(stored.mediaType, input.filename);
  const ingest = prepareIngestBody(classification, input.bytes, stored.mediaType, input.filename);
  const title =
    input.titleOverride?.slice(0, TITLE_MAX) ||
    titleFromFilename(input.filename).slice(0, TITLE_MAX);

  const id = randomUUID();
  const body = await sealLawText(
    prisma,
    {
      table: "law_documents",
      column: "body",
      rowId: id,
      spaceId: actor.spaceId,
      owner: input.caseId,
    },
    ingest.body,
  );
  const created = await prisma.lawDocument.create({
    data: {
      id,
      caseId: input.caseId,
      title,
      filename: input.filename,
      body,
      kind: "upload",
      version: 1,
      source: "upload",
      mimeType: stored.mediaType,
      sizeBytes: stored.sizeBytes,
      sha256,
      artifactId: stored.artifactId,
      status: ingest.status,
      statusDetail: ingest.statusDetail,
      uploadedBy: actor.userId,
      updatedAt: new Date(),
    },
  });
  await enqueueExtraction(prisma, {
    id: created.id,
    caseId: created.caseId,
    kind: classification.kind,
  });
  return { ...created, body: ingest.body };
}

async function requireMember(
  prisma: PrismaClient,
  userId: string,
  caseId: string,
): Promise<boolean> {
  const member = await prisma.lawCaseMember.findUnique({
    where: { caseId_userId: { caseId, userId } },
    select: { userId: true },
  });
  if (!member) return false;
  const lawCase = await prisma.lawCase.findUnique({
    where: { id: caseId },
    select: { deletedAt: true },
  });
  return Boolean(lawCase && !lawCase.deletedAt);
}

export function sanitizeFilename(raw: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  let cleaned = "";
  for (const ch of base) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) continue;
    cleaned += ch;
    if (cleaned.length >= FILENAME_MAX) break;
  }
  return cleaned || "upload";
}

function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "") || filename;
  return base || "Upload";
}
