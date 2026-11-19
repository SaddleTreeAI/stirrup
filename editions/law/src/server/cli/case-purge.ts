// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

/**
 * Permanently purge a soft-deleted case (or dry-run counts).
 *
 *   pnpm --filter @rakazo/edition-law case:purge --case <id> [--dry-run]
 *   pnpm --filter @rakazo/edition-law case:purge --case <id> --force-before-retention --confirm <id>
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { asSystem, createDb } from "@rakazo/db";
import { purgeLawCase } from "../media/handlers/purge-case.js";

const USAGE = `Usage: case:purge --case <id> [--dry-run] [--force-before-retention --confirm <id>]
  Permanently removes a soft-deleted case after its retention window.
  --dry-run                 Print counts only; change nothing
  --force-before-retention  Allow purge before purgeAfter (requires --confirm <same id>)
`;

export type CasePurgeCliArgs = {
  caseId: string;
  dryRun: boolean;
  forceBeforeRetention: boolean;
  confirm?: string;
};

export function parseCasePurgeArgs(argv: string[]): CasePurgeCliArgs | { error: string } {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      options: {
        case: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "force-before-retention": { type: "boolean", default: false },
        confirm: { type: "string" },
      },
    });
  } catch {
    return { error: USAGE };
  }
  const caseId = parsed.values.case;
  if (typeof caseId !== "string" || !caseId.trim()) return { error: USAGE };
  const force = parsed.values["force-before-retention"] === true;
  const confirm = typeof parsed.values.confirm === "string" ? parsed.values.confirm : undefined;
  if (force && confirm !== caseId) {
    return {
      error: "--force-before-retention requires --confirm <case-id> matching --case\n" + USAGE,
    };
  }
  return {
    caseId: caseId.trim(),
    dryRun: parsed.values["dry-run"] === true,
    forceBeforeRetention: force,
    confirm,
  };
}

export async function runCasePurge(
  databaseUrl: string,
  args: CasePurgeCliArgs,
): Promise<{ exitCode: number; lines: string[] }> {
  const { prisma, pool } = createDb(databaseUrl, { applicationName: "law-case-purge" });
  const db = asSystem(prisma, "law case purge");
  try {
    const result = await purgeLawCase(db, {
      caseId: args.caseId,
      dryRun: args.dryRun,
      forceBeforeRetention: args.forceBeforeRetention,
    });
    if (!result.ok) {
      return {
        exitCode: 1,
        lines: [`refused: ${result.reason} (caseId=${args.caseId})`],
      };
    }
    const { counts } = result;
    const prefix = result.dryRun ? "dry-run" : "purged";
    return {
      exitCode: 0,
      lines: [
        `${prefix} caseId=${args.caseId}`,
        `artifacts=${counts.artifacts} frames=${counts.frames} segments=${counts.segments} pages=${counts.pages}`,
        `documents=${counts.documents} jobs=${counts.jobs} members=${counts.members} caseBots=${counts.caseBots} botsArchived=${counts.botsArchived}`,
      ],
    };
  } finally {
    await pool.end();
  }
}

async function main() {
  loadRootEnv();
  const args = parseCasePurgeArgs(process.argv.slice(2));
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
  const { exitCode, lines } = await runCasePurge(databaseUrl, args);
  for (const line of lines) process.stdout.write(`${line}\n`);
  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
