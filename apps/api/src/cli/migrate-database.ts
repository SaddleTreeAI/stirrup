// `pnpm db:migrate`: schema migrations, the job queue schema, then the runtime
// login. Everything here runs as the migration (owner) role; the API and worker
// then connect with DATABASE_URL and only get the runtime grants.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { migrateJobQueue, unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import {
  databaseUrls,
  deployMigrations,
  provisionRuntimeRole,
  RUNTIME_ROLE,
  SINGLE_DATABASE_URL_WARNING,
} from "@rakazo/db";

loadRootEnv();
await unwrapEnvFromKeyManager();
const urls = databaseUrls(process.env);
// A packaged server has no pnpm, so it names the database package's folder itself.
const dbPackageDir = process.env.RAKAZO_DB_PACKAGE_DIR
  ? path.resolve(process.env.RAKAZO_DB_PACKAGE_DIR)
  : execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "pwd"], {
      encoding: "utf8",
    }).trim();
await deployMigrations({
  migrationUrl: urls.migrationUrl,
  previousMigrations: process.env.RAKAZO_DEPLOYED_MIGRATIONS?.split(","),
  dbPackageDir,
  // edition-seam:C2 — refuse a mismatched prepared tree; use .edition/migrations when present.
  migrationsDir: (() => {
    const editionId = process.env.STIRRUP_EDITION?.trim() || "default";
    const stamp = path.join(dbPackageDir, "prisma/.edition/edition");
    const prepared = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : "";
    if (editionId !== "default" && prepared !== editionId) {
      throw new Error(
        `Database tree was prepared for "${prepared || "none"}" but STIRRUP_EDITION is "${editionId}". Run STIRRUP_EDITION=${editionId} pnpm --filter @rakazo/db generate first.`,
      );
    }
    const editionMigrations = path.join(dbPackageDir, "prisma/.edition/migrations");
    return editionId !== "default" && existsSync(editionMigrations) ? editionMigrations : undefined;
  })(),
});
await migrateJobQueue(urls.migrationUrl);

if (!urls.separate) {
  process.stderr.write(`WARNING: ${SINGLE_DATABASE_URL_WARNING}\n`);
} else {
  const { warning } = await provisionRuntimeRole(urls.migrationUrl, urls.url);
  if (warning) process.stderr.write(`WARNING: ${warning}\n`);
  else process.stdout.write(`Runtime login is ready (member of ${RUNTIME_ROLE}).\n`);
}
