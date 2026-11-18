#!/usr/bin/env node
// Merge core Prisma schema with every edition's models, and (for a non-default
// edition) assemble core + edition migrations under packages/db/prisma/.edition/.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GENERATOR_OUTPUT = 'output   = "../../src/generated/prisma"';
const MODEL_OR_ENUM = /^(?:model|enum)\s+(\w+)/gm;

function usage() {
  process.stderr.write(
    "Usage: node scripts/editions/prepare-db.mjs [--edition <id>] [--root <dir>]\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  let edition;
  let root;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--edition") {
      edition = argv[++i];
      if (!edition) usage();
      continue;
    }
    if (arg === "--root") {
      root = argv[++i];
      if (!root) usage();
      continue;
    }
    usage();
  }
  return { edition, root };
}

function resolveRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function resolveEditionId(explicit) {
  const raw = explicit ?? process.env.STIRRUP_EDITION ?? "default";
  const trimmed = raw.trim();
  return trimmed || "default";
}

function listEditionModelFiles(editionsDir) {
  if (!existsSync(editionsDir)) return [];
  const files = [];
  for (const entry of readdirSync(editionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dbDir = path.join(editionsDir, entry.name, "db");
    if (!existsSync(dbDir) || !statSync(dbDir).isDirectory()) continue;
    for (const name of readdirSync(dbDir).sort()) {
      if (!name.endsWith(".prisma")) continue;
      files.push({
        editionId: entry.name,
        relative: path.join("editions", entry.name, "db", name),
        absolute: path.join(dbDir, name),
      });
    }
  }
  files.sort(
    (a, b) => a.editionId.localeCompare(b.editionId) || a.relative.localeCompare(b.relative),
  );
  return files;
}

function collectNames(source, label, into) {
  MODEL_OR_ENUM.lastIndex = 0;
  for (const match of source.matchAll(MODEL_OR_ENUM)) {
    const name = match[1];
    const prior = into.get(name);
    if (prior) {
      throw new Error(`Duplicate model or enum "${name}" in ${label} (also in ${prior})`);
    }
    into.set(name, label);
  }
}

function rewriteGeneratorOutput(schema) {
  if (!/output\s*=\s*"[^"]+"/.test(schema)) {
    throw new Error('Core schema is missing a generator output = "..." line');
  }
  return schema.replace(/output\s*=\s*"[^"]+"/, GENERATOR_OUTPUT);
}

function migrationDirNames(migrationsDir) {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function writeIfChanged(file, contents) {
  if (existsSync(file) && readFileSync(file, "utf8") === contents) return false;
  writeFileSync(file, contents);
  return true;
}

function prepareDb({ root, editionId }) {
  const coreSchemaPath = path.join(root, "packages/db/prisma/schema.prisma");
  const coreMigrationsDir = path.join(root, "packages/db/prisma/migrations");
  const outDir = path.join(root, "packages/db/prisma/.edition");
  const outSchema = path.join(outDir, "schema.prisma");
  const outEdition = path.join(outDir, "edition");
  const outMigrations = path.join(outDir, "migrations");
  const editionsDir = path.join(root, "editions");

  if (!existsSync(coreSchemaPath)) {
    throw new Error(`Missing core schema at ${coreSchemaPath}`);
  }

  if (editionId !== "default") {
    const editionDir = path.join(editionsDir, editionId);
    if (!existsSync(editionDir) || !statSync(editionDir).isDirectory()) {
      throw new Error(`Unknown edition "${editionId}": editions/${editionId} does not exist`);
    }
  }

  mkdirSync(outDir, { recursive: true });
  // Migrations always rebuild; schema is written only when content changes so
  // generateClientIfStale can skip a no-op regenerate on every pnpm dev.
  rmSync(outMigrations, { recursive: true, force: true });

  const coreSchema = readFileSync(coreSchemaPath, "utf8");
  const names = new Map();
  collectNames(coreSchema, "packages/db/prisma/schema.prisma", names);

  const modelFiles = listEditionModelFiles(editionsDir);
  const parts = [rewriteGeneratorOutput(coreSchema)];
  let modelCount = 0;
  for (const file of modelFiles) {
    const body = readFileSync(file.absolute, "utf8").replace(/\s+$/, "");
    collectNames(body, file.relative, names);
    parts.push(`\n\n// from ${file.relative}\n${body}\n`);
    modelCount += 1;
  }
  writeIfChanged(outSchema, parts.join("").replace(/\n+$/, "\n"));
  writeFileSync(outEdition, `${editionId}\n`);

  let migrationCount = 0;
  if (editionId === "default") {
    process.stdout.write(
      `prepare-db: edition=default models=${modelCount} migrations=core (no .edition/migrations)\n`,
    );
    return { editionId, modelCount, migrationCount: 0, migrationsDir: null };
  }

  const editionMigrationsDir = path.join(editionsDir, editionId, "db", "migrations");
  if (!existsSync(editionMigrationsDir) || !statSync(editionMigrationsDir).isDirectory()) {
    process.stdout.write(
      `prepare-db: edition=${editionId} models=${modelCount} migrations=core (no edition migrations)\n`,
    );
    return { editionId, modelCount, migrationCount: 0, migrationsDir: null };
  }

  const coreNames = migrationDirNames(coreMigrationsDir);
  const editionNames = migrationDirNames(editionMigrationsDir);
  const lastCore = coreNames.at(-1);
  if (lastCore) {
    for (const name of editionNames) {
      if (name.localeCompare(lastCore) <= 0) {
        throw new Error(
          `Edition migration "${name}" must sort after the last core migration "${lastCore}" (use a 9999-prefixed directory name)`,
        );
      }
    }
  }

  mkdirSync(outMigrations, { recursive: true });
  if (existsSync(coreMigrationsDir)) {
    cpSync(coreMigrationsDir, outMigrations, { recursive: true });
  }
  for (const name of editionNames) {
    cpSync(path.join(editionMigrationsDir, name), path.join(outMigrations, name), {
      recursive: true,
    });
  }
  migrationCount = editionNames.length;
  process.stdout.write(
    `prepare-db: edition=${editionId} models=${modelCount} migrations=+${migrationCount}\n`,
  );
  return { editionId, modelCount, migrationCount, migrationsDir: outMigrations };
}

const { edition, root: rootArg } = parseArgs(process.argv.slice(2));
const root = resolveRoot(rootArg);
const editionId = resolveEditionId(edition);

try {
  prepareDb({ root, editionId });
} catch (error) {
  process.stderr.write(`prepare-db failed: ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}

export { prepareDb, resolveEditionId, resolveRoot };
