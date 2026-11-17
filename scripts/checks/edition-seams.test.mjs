// Keeps edition packages behind labeled seams: only listed files may name them, seam comments
// stay well-formed, packages/* never import editions, and editions/* never import apps/*.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const EDITION_MENTION = /@rakazo\/edition-|@edition\/web/;
const SEAM_COMMENT = /edition-seam:([^\s*/]*)/g;
const SEAM_ID = /^[A-Z][0-9A-Za-z-]*$/;
const MAX_SEAM_ID_USES = 12;

/** Files outside editions/ and docs/ that may mention edition packages or the web alias. */
const ALLOWED_EDITION_MENTIONS = [
  "apps/api/package.json",
  "apps/api/src/edition/active.ts",
  "apps/web/src/edition.ts",
  "apps/web/tsconfig.json",
  "apps/web/vite.config.ts",
  "apps/worker/package.json",
  "apps/worker/src/edition/active.ts",
  "pnpm-lock.yaml",
  "scripts/checks/edition-seams.test.mjs",
  "scripts/checks/import-boundaries.allowlist.json",
  "vitest.config.ts",
];

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 << 20,
})
  .split("\0")
  .filter(Boolean);

const SOURCE_OR_CONFIG =
  /\.(?:[cm]?[jt]sx?|json|jsonc|mjs|cjs|yaml|yml|md|toml|lock)$|^(?:pnpm-lock\.yaml)$/;

test("edition package names appear only in the allowlisted seam files", () => {
  const offenders = tracked
    .filter((file) => !file.startsWith("editions/") && !file.startsWith("docs/"))
    .filter((file) => SOURCE_OR_CONFIG.test(file) || file === "pnpm-lock.yaml")
    .flatMap((file) => {
      if (ALLOWED_EDITION_MENTIONS.includes(file)) return [];
      const text = readFileSync(path.join(root, file), "utf8");
      return EDITION_MENTION.test(text) ? [file] : [];
    })
    .sort();
  assert.deepEqual(
    offenders,
    [],
    "Add the file to ALLOWED_EDITION_MENTIONS in scripts/checks/edition-seams.test.mjs, or remove the edition import.",
  );
});

test("edition-seam comments use edition-seam:<ID> and no id appears more than 12 times", () => {
  const counts = new Map();
  const malformed = [];
  for (const file of tracked) {
    // This file describes the rule; its examples are not live seam markers.
    if (file.startsWith("docs/") || file === "scripts/checks/edition-seams.test.mjs") continue;
    const absolute = path.join(root, file);
    if (!statSync(absolute).isFile()) continue;
    const text = readFileSync(absolute, "utf8");
    if (!text.includes("edition-seam:")) continue;
    for (const match of text.matchAll(SEAM_COMMENT)) {
      const id = match[1] ?? "";
      if (!SEAM_ID.test(id)) {
        malformed.push(`${file}: edition-seam:${id || "(empty)"}`);
        continue;
      }
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  assert.deepEqual(malformed, [], "Use edition-seam:<ID> with ID matching /^[A-Z][0-9A-Za-z-]*$/");
  const overused = [...counts.entries()]
    .filter(([, count]) => count > MAX_SEAM_ID_USES)
    .map(([id, count]) => `${id} (${count})`)
    .sort();
  assert.deepEqual(
    overused,
    [],
    `No edition-seam id may appear more than ${MAX_SEAM_ID_USES} times; split the work or use a new id.`,
  );
});

test("packages/* never import @rakazo/edition-*", () => {
  const offenders = tracked
    .filter((file) => file.startsWith("packages/") && /\.[cm]?[jt]sx?$/.test(file))
    .flatMap((file) => {
      const text = readFileSync(path.join(root, file), "utf8");
      return /@rakazo\/edition-/.test(text) ? [file] : [];
    })
    .sort();
  assert.deepEqual(
    offenders,
    [],
    "Edition packages are selected only at app seams, never from packages/*.",
  );
});

test("editions/* never import from apps/*", () => {
  const offenders = tracked
    .filter((file) => file.startsWith("editions/") && /\.[cm]?[jt]sx?$/.test(file))
    .flatMap((file) => {
      const text = readFileSync(path.join(root, file), "utf8");
      const hits = [];
      for (const match of text.matchAll(
        /(?:from\s+|import\s*\(\s*)["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']/g,
      )) {
        const specifier = match[1] ?? match[2] ?? "";
        if (
          specifier.includes("apps/") ||
          /^@rakazo\/(?:web|api|worker|mobile|desktop)\b/.test(specifier)
        ) {
          hits.push(`${file} -> ${specifier}`);
        }
      }
      return hits;
    })
    .sort();
  assert.deepEqual(
    offenders,
    [],
    "Edition code reaches the host through seams, not by importing apps/*.",
  );
});
