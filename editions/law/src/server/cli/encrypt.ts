// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

/**
 * Encrypt / decrypt / reencrypt law text columns in batches.
 * Prints counts only — never document or brief text.
 *
 *   pnpm --filter @rakazo/edition-law encrypt:backfill [--dry-run] [--case <id>]
 *   pnpm --filter @rakazo/edition-law encrypt:decrypt [--dry-run] [--case <id>]
 *   pnpm --filter @rakazo/edition-law encrypt:reencrypt [--dry-run] [--case <id>]
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, ciphertextKeyId, contentEncryptionOf, createDb, isCiphertext } from "@rakazo/db";
import { LAW_SEALED_COLUMNS, openLawText, sealLawText } from "../seal.js";

const BATCH = 200;
const USAGE = `Usage: encrypt <backfill|decrypt|reencrypt> [--dry-run] [--case <id>]
  backfill    Encrypt plaintext law text (idempotent; skips ciphertext)
  decrypt     Write plaintext back (emergency exit)
  reencrypt   Rewrite rows sealed under an older space key version
`;

type Mode = "backfill" | "decrypt" | "reencrypt";

type Scanned = {
  id: string;
  value: string;
  spaceId: string;
  owner: string;
};

export type EncryptProgress = {
  table: string;
  column: string;
  scanned: number;
  updated: number;
};

export async function migrateLawText(
  prisma: PrismaClient,
  options: {
    mode: Mode;
    dryRun?: boolean;
    caseId?: string;
    batchSize?: number;
  },
): Promise<EncryptProgress[]> {
  if (!contentEncryptionOf(prisma)) {
    throw new Error("Law encrypt needs an encrypting database client");
  }
  const batchSize = options.batchSize ?? BATCH;
  const results: EncryptProgress[] = [];
  for (const spec of LAW_SEALED_COLUMNS) {
    let cursor = "";
    let scanned = 0;
    let updated = 0;
    for (;;) {
      const rows = await scanBatch(prisma, spec, cursor, batchSize, options.caseId);
      if (rows.length === 0) break;
      for (const row of rows) {
        scanned += 1;
        cursor = row.id;
        const needs = await needsWork(prisma, options.mode, row);
        if (!needs) continue;
        updated += 1;
        if (options.dryRun) continue;
        const location = {
          table: spec.table,
          column: spec.column,
          rowId: row.id,
          spaceId: row.spaceId,
          owner: row.owner,
        };
        const plain = await openLawText(prisma, location, row.value);
        const next =
          options.mode === "decrypt" ? plain : await sealLawText(prisma, location, plain);
        await writeValue(prisma, spec.table, row.id, next);
      }
      if (rows.length < batchSize) break;
    }
    results.push({ table: spec.table, column: spec.column, scanned, updated });
  }
  return results;
}

async function needsWork(prisma: PrismaClient, mode: Mode, row: Scanned): Promise<boolean> {
  if (mode === "decrypt") return isCiphertext(row.value);
  if (!isCiphertext(row.value)) return true;
  if (mode !== "reencrypt") return false;
  const encryption = contentEncryptionOf(prisma);
  if (!encryption) return false;
  const current = await encryption.ring.current(row.spaceId);
  return ciphertextKeyId(row.value) !== current.id;
}

async function scanBatch(
  prisma: PrismaClient,
  spec: (typeof LAW_SEALED_COLUMNS)[number],
  cursor: string,
  limit: number,
  caseId: string | undefined,
): Promise<Scanned[]> {
  if (spec.table === "law_cases") {
    if (caseId) {
      if (cursor !== "") return [];
      const row = await prisma.lawCase.findUnique({
        where: { id: caseId },
        select: { id: true, brief: true, spaceId: true },
      });
      if (!row) return [];
      return [{ id: row.id, value: row.brief, spaceId: row.spaceId, owner: row.spaceId }];
    }
    const rows = await prisma.lawCase.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: "asc" },
      take: limit,
      select: { id: true, brief: true, spaceId: true },
    });
    return rows.map((row) => ({
      id: row.id,
      value: row.brief,
      spaceId: row.spaceId,
      owner: row.spaceId,
    }));
  }
  if (spec.table === "law_documents") {
    const rows = await prisma.lawDocument.findMany({
      where: {
        id: { gt: cursor },
        ...(caseId ? { caseId } : {}),
      },
      orderBy: { id: "asc" },
      take: limit,
      select: { id: true, body: true, caseId: true },
    });
    if (rows.length === 0) return [];
    const spaceByCase = await spaceIdsForCases(prisma, [...new Set(rows.map((row) => row.caseId))]);
    return rows.flatMap((row) => {
      const spaceId = spaceByCase.get(row.caseId);
      if (!spaceId) return [];
      return [{ id: row.id, value: row.body, spaceId, owner: row.caseId }];
    });
  }
  if (spec.table === "law_document_pages") {
    const documentIds = await documentIdsForCase(prisma, caseId);
    if (caseId && documentIds.length === 0) return [];
    const rows = await prisma.lawDocumentPage.findMany({
      where: {
        id: { gt: cursor },
        ...(caseId ? { documentId: { in: documentIds } } : {}),
      },
      orderBy: { id: "asc" },
      take: limit,
      select: { id: true, documentId: true, text: true },
    });
    return attachChildSpace(
      prisma,
      rows.map((row) => ({ ...row, value: row.text })),
    );
  }
  if (spec.table === "law_transcript_segments") {
    const documentIds = await documentIdsForCase(prisma, caseId);
    if (caseId && documentIds.length === 0) return [];
    const rows = await prisma.lawTranscriptSegment.findMany({
      where: {
        id: { gt: cursor },
        ...(caseId ? { documentId: { in: documentIds } } : {}),
      },
      orderBy: { id: "asc" },
      take: limit,
      select: { id: true, documentId: true, text: true },
    });
    return attachChildSpace(
      prisma,
      rows.map((row) => ({ ...row, value: row.text })),
    );
  }
  const documentIds = await documentIdsForCase(prisma, caseId);
  if (caseId && documentIds.length === 0) return [];
  const rows = await prisma.lawMediaFrame.findMany({
    where: {
      id: { gt: cursor },
      ...(caseId ? { documentId: { in: documentIds } } : {}),
    },
    orderBy: { id: "asc" },
    take: limit,
    select: { id: true, documentId: true, caption: true },
  });
  return attachChildSpace(
    prisma,
    rows.map((row) => ({ ...row, value: row.caption })),
  );
}

async function documentIdsForCase(
  prisma: PrismaClient,
  caseId: string | undefined,
): Promise<string[]> {
  if (!caseId) return [];
  return (
    await prisma.lawDocument.findMany({
      where: { caseId },
      select: { id: true },
    })
  ).map((row) => row.id);
}

async function attachChildSpace(
  prisma: PrismaClient,
  rows: Array<{ id: string; documentId: string; value: string }>,
): Promise<Scanned[]> {
  if (rows.length === 0) return [];
  const docs = await prisma.lawDocument.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.documentId))] } },
    select: { id: true, caseId: true },
  });
  const caseByDoc = new Map(docs.map((doc) => [doc.id, doc.caseId]));
  const spaceByCase = await spaceIdsForCases(prisma, [...new Set(docs.map((doc) => doc.caseId))]);
  return rows.flatMap((row) => {
    const caseIdForDoc = caseByDoc.get(row.documentId);
    const spaceId = caseIdForDoc ? spaceByCase.get(caseIdForDoc) : undefined;
    if (!spaceId) return [];
    return [{ id: row.id, value: row.value, spaceId, owner: row.documentId }];
  });
}

async function spaceIdsForCases(
  prisma: PrismaClient,
  caseIds: string[],
): Promise<Map<string, string>> {
  if (caseIds.length === 0) return new Map();
  const cases = await prisma.lawCase.findMany({
    where: { id: { in: caseIds } },
    select: { id: true, spaceId: true },
  });
  return new Map(cases.map((row) => [row.id, row.spaceId]));
}

async function writeValue(
  prisma: PrismaClient,
  table: string,
  id: string,
  value: string,
): Promise<void> {
  if (table === "law_cases") {
    await prisma.lawCase.update({ where: { id }, data: { brief: value } });
    return;
  }
  if (table === "law_documents") {
    await prisma.lawDocument.update({ where: { id }, data: { body: value } });
    return;
  }
  if (table === "law_document_pages") {
    await prisma.lawDocumentPage.update({ where: { id }, data: { text: value } });
    return;
  }
  if (table === "law_transcript_segments") {
    await prisma.lawTranscriptSegment.update({ where: { id }, data: { text: value } });
    return;
  }
  await prisma.lawMediaFrame.update({ where: { id }, data: { caption: value } });
}

async function main() {
  loadRootEnv();
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        "dry-run": { type: "boolean" },
        case: { type: "string" },
      },
    });
  } catch {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const mode = parsed.positionals[0] as Mode | undefined;
  if (
    !mode ||
    !["backfill", "decrypt", "reencrypt"].includes(mode) ||
    parsed.positionals.length > 1
  ) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const databaseUrl =
    process.env.DATABASE_MIGRATION_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Set DATABASE_URL.");
  const encrypting = mode !== "decrypt";
  const { prisma, pool } = createDb(databaseUrl, {
    applicationName: "law-encrypt",
    ...(encrypting ? { encryptContent: true } : {}),
  });
  const db = asSystem(prisma, "law encrypt");
  try {
    const dryRun = parsed.values["dry-run"] === true;
    const results = await migrateLawText(db, {
      mode,
      dryRun,
      caseId: typeof parsed.values.case === "string" ? parsed.values.case : undefined,
    });
    for (const row of results) {
      process.stdout.write(
        `${row.table}.${row.column}: ${row.updated} of ${row.scanned} ${
          dryRun ? "to rewrite" : "rewritten"
        }\n`,
      );
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
