// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { asSystem, createDb } from "@rakazo/db";
import { backfillLawAvatars } from "../cases.js";

export async function runAvatarsBackfill(databaseUrl: string): Promise<{
  updated: number;
  skipped: number;
}> {
  const { prisma, pool } = createDb(databaseUrl);
  const db = asSystem(prisma, "law avatars backfill");
  try {
    return await backfillLawAvatars(db);
  } finally {
    await pool.end();
  }
}

async function main() {
  loadRootEnv();
  const databaseUrl =
    process.env.DATABASE_MIGRATION_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Set DATABASE_URL.");
  const result = await runAvatarsBackfill(databaseUrl);
  process.stdout.write(`Updated ${result.updated} bots; skipped ${result.skipped}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
