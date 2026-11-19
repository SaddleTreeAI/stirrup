// Ensures Tailwind scans editions/*/src so edition-only utility classes produce CSS.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stylesPath = path.join(root, "apps/web/src/styles.css");
const stylesDir = path.dirname(stylesPath);

test("styles.css has a W9 @source that resolves to the editions folder", () => {
  const text = readFileSync(stylesPath, "utf8");
  const lines = text.split(/\r?\n/);

  assert.ok(
    lines.some((line) => line.includes('@source "../../packages/ui-web/src/**/*.{ts,tsx}"')),
    "Keep the existing ui-web @source line unchanged",
  );

  const sourceRe = /@source\s+"([^"]+)"/;
  const sources = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(sourceRe);
    if (!match) continue;
    sources.push({ line: lines[i], index: i, pattern: match[1] });
  }
  assert.ok(sources.length > 0, "Expected at least one @source in styles.css");

  const editionsSources = sources.filter(({ pattern, index }) => {
    const globStart = pattern.indexOf("*");
    assert.notEqual(globStart, -1, `@source "${pattern}" must include a glob`);
    const dirPart = pattern.slice(0, globStart);
    const resolved = path.resolve(stylesDir, dirPart);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return false;
    const real = path.resolve(resolved);
    const editionsRoot = path.resolve(root, "editions");
    if (real !== editionsRoot) return false;
    const previous = lines[index - 1] ?? "";
    // Build the marker at runtime so this check file is not scanned as a live seam.
    const w9Marker = ["edition-seam", "W9"].join(":");
    assert.ok(
      previous.includes(w9Marker),
      `Line above editions @source must contain ${w9Marker} (got: ${previous})`,
    );
    return true;
  });

  assert.ok(
    editionsSources.length >= 1,
    "At least one @source must resolve to the repo editions/ directory",
  );
});
