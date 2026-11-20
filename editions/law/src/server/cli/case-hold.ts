// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

/**
 * Toggle legal hold on a case.
 *
 *   pnpm --filter @rakazo/edition-law case:hold <id> on|off
 *
 * Prints the new state and writes audit event law.case.hold (ids only).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, installAuditEventStore, tryRecordAuditEvent } from "@rakazo/db";

const USAGE = `Usage: case:hold <case-id> on|off
`;

export type CaseHoldArgs = {
  caseId: string;
  hold: boolean;
};

export function parseCaseHoldArgs(argv: string[]): CaseHoldArgs | { error: string } {
  if (argv.length !== 2) return { error: USAGE };
  const [caseId, mode] = argv;
  if (!caseId?.trim() || (mode !== "on" && mode !== "off")) return { error: USAGE };
  return { caseId: caseId.trim(), hold: mode === "on" };
}

export async function setCaseLegalHold(
  prisma: PrismaClient,
  args: CaseHoldArgs,
): Promise<{ ok: true; caseId: string; legalHold: boolean } | { ok: false; reason: "not_found" }> {
  const row = await prisma.lawCase.findUnique({
    where: { id: args.caseId },
    select: { id: true, spaceId: true, legalHold: true },
  });
  if (!row) return { ok: false, reason: "not_found" };

  const updated = await prisma.lawCase.update({
    where: { id: args.caseId },
    data: { legalHold: args.hold },
    select: { id: true, legalHold: true, spaceId: true },
  });

  installAuditEventStore(prisma);
  await tryRecordAuditEvent({
    action: "law.case.hold",
    actor: { type: "system", label: "law-case-hold" },
    spaceId: updated.spaceId,
    target: { type: "case", id: updated.id },
    metadata: {
      caseId: updated.id,
      legalHold: updated.legalHold,
    },
  });

  return { ok: true, caseId: updated.id, legalHold: updated.legalHold };
}

export async function runCaseHold(
  databaseUrl: string,
  args: CaseHoldArgs,
): Promise<{ exitCode: number; lines: string[] }> {
  const { prisma, pool } = createDb(databaseUrl, { applicationName: "law-case-hold" });
  const db = asSystem(prisma, "law case hold");
  try {
    const result = await setCaseLegalHold(db, args);
    if (!result.ok) {
      return { exitCode: 1, lines: [`refused: ${result.reason}`] };
    }
    return {
      exitCode: 0,
      lines: [`caseId=${result.caseId} legalHold=${result.legalHold ? "on" : "off"}`],
    };
  } finally {
    await pool.end();
  }
}

async function main() {
  loadRootEnv();
  const args = parseCaseHoldArgs(process.argv.slice(2));
  if ("error" in args) {
    process.stderr.write(args.error);
    process.exit(2);
  }
  const databaseUrl =
    process.env.DATABASE_MIGRATION_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    process.stderr.write("Set DATABASE_URL.\n");
    process.exit(2);
  }
  const { exitCode, lines } = await runCaseHold(databaseUrl, args);
  for (const line of lines) process.stdout.write(`${line}\n`);
  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
