// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI
//
// Dev-only: rasterize role tiles to webp data URLs and write src/shared/avatars.ts.
// Run: node editions/law/scripts/build-avatars.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_TS = path.join(ROOT, "src/shared/avatars.ts");
const PREVIEW_DIR = path.join(ROOT, "scripts/avatar-previews");
const MAX_CHARS = 40_000;
const SIZE = 256;

/** @typedef {"manager" | "documents" | "transcripts" | "generator"} LawRole */

/** @type {Record<LawRole, { bg: string; ink: string; svg: string }>} */
const TILES = {
  manager: {
    bg: "#2F3E4E",
    ink: "#E8D5A3",
    svg: `
      <g fill="none" stroke="#E8D5A3" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
        <path d="M128 48 V188" />
        <path d="M88 188 H168" />
        <path d="M128 72 H168" />
        <path d="M168 72 C188 72 204 88 204 108 C204 128 188 144 168 144 C148 144 132 128 132 108" />
        <path d="M128 72 H88" />
        <path d="M88 72 C68 72 52 88 52 108 C52 128 68 144 88 144 C108 144 124 128 124 108" />
        <circle cx="128" cy="56" r="8" fill="#E8D5A3" stroke="none" />
      </g>`,
  },
  documents: {
    bg: "#3D4A3C",
    ink: "#F0E6D2",
    svg: `
      <g fill="#F0E6D2" opacity="0.95">
        <path d="M72 86 H164 C172 86 178 92 178 100 V178 C178 186 172 192 164 192 H72 C64 192 58 186 58 178 V100 C58 92 64 86 72 86 Z" />
        <path d="M84 70 H176 C184 70 190 76 190 84 V166 C190 170 188 174 184 176 V100 C184 88 174 78 162 78 H84 C80 78 76 76 76 72 C76 70 80 70 84 70 Z" opacity="0.7" />
        <path d="M96 54 H188 C196 54 202 60 202 68 V150 C202 154 200 158 196 160 V84 C196 72 186 62 174 62 H96 C92 62 88 60 88 56 C88 54 92 54 96 54 Z" opacity="0.45" />
      </g>
      <g fill="#3D4A3C">
        <rect x="78" y="118" width="72" height="8" rx="4" />
        <rect x="78" y="138" width="56" height="8" rx="4" />
        <rect x="78" y="158" width="64" height="8" rx="4" />
      </g>`,
  },
  transcripts: {
    bg: "#2C4550",
    ink: "#B8D4E0",
    svg: `
      <g fill="none" stroke="#B8D4E0" stroke-width="8" stroke-linecap="round">
        <path d="M48 128 H72" />
        <path d="M72 100 V156" />
        <path d="M88 84 V172" />
        <path d="M104 112 V144" />
        <path d="M120 72 V184" />
        <path d="M136 96 V160" />
        <path d="M152 108 V148" />
        <path d="M168 80 V176" />
        <path d="M184 116 V140" />
        <path d="M200 128 H220" />
      </g>
      <g fill="#B8D4E0" opacity="0.85">
        <rect x="64" y="196" width="96" height="8" rx="4" />
        <rect x="64" y="212" width="72" height="8" rx="4" />
      </g>`,
  },
  generator: {
    bg: "#4A3538",
    ink: "#F2E2D0",
    svg: `
      <g fill="#F2E2D0">
        <path d="M78 64 H168 C176 64 182 70 182 78 V188 C182 196 176 202 168 202 H78 C70 202 64 196 64 188 V78 C64 70 70 64 78 64 Z" opacity="0.92" />
        <rect x="84" y="88" width="76" height="8" rx="4" fill="#4A3538" />
        <rect x="84" y="108" width="60" height="8" rx="4" fill="#4A3538" />
        <rect x="84" y="128" width="68" height="8" rx="4" fill="#4A3538" />
      </g>
      <g fill="none" stroke="#C4A484" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M158 168 L198 88" />
        <path d="M198 88 L210 100 L170 180 L152 176 Z" fill="#C4A484" stroke="none" />
        <path d="M152 176 L148 192 L164 184" stroke="#C4A484" />
      </g>`,
  },
};

/**
 * @param {LawRole} role
 * @param {{ bg: string; svg: string }} tile
 */
function tileSvg(_role, tile) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" rx="48" ry="48" fill="${tile.bg}"/>
  ${tile.svg}
</svg>`;
}

/**
 * @param {Buffer} webp
 * @param {string} light
 * @param {string} dark
 */
async function contrastOk(webp, light, dark) {
  // Sample the centre of the rendered tile against light/dark backdrops via mean luminance delta.
  const tile = await sharp(webp).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = tile;
  const mid =
    Math.floor(info.width / 2) * info.channels +
    Math.floor(info.height / 2) * info.width * info.channels;
  // Use average of non-transparent samples instead of a single pixel.
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const a = data[i + 3] ?? 255;
    if (a < 200) continue;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    count += 1;
  }
  const mean = count ? sum / count : 0;
  const parse = (hex) => {
    const h = hex.slice(1);
    return [
      Number.parseInt(h.slice(0, 2), 16),
      Number.parseInt(h.slice(2, 4), 16),
      Number.parseInt(h.slice(4, 6), 16),
    ];
  };
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const againstLight = Math.abs(mean - lum(parse(light)));
  const againstDark = Math.abs(mean - lum(parse(dark)));
  if (againstLight < 40 || againstDark < 40) {
    throw new Error(
      `Tile contrast too low (mean=${mean.toFixed(1)}, Δlight=${againstLight.toFixed(1)}, Δdark=${againstDark.toFixed(1)})`,
    );
  }
  void mid;
}

async function main() {
  mkdirSync(PREVIEW_DIR, { recursive: true });
  /** @type {Partial<Record<LawRole, string>>} */
  const urls = {};
  for (const role of /** @type {LawRole[]} */ (Object.keys(TILES))) {
    const tile = TILES[role];
    const svg = Buffer.from(tileSvg(role, tile));
    let quality = 82;
    let webp;
    let dataUrl = "";
    while (quality >= 40) {
      webp = await sharp(svg).webp({ quality, effort: 6 }).toBuffer();
      dataUrl = `data:image/webp;base64,${webp.toString("base64")}`;
      if (dataUrl.length <= MAX_CHARS) break;
      quality -= 6;
    }
    if (!webp || dataUrl.length > MAX_CHARS) {
      throw new Error(`${role} data URL still ${dataUrl.length} chars after quality=${quality}`);
    }
    const meta = await sharp(webp).metadata();
    if (meta.width !== SIZE || meta.height !== SIZE) {
      throw new Error(`${role} size ${meta.width}x${meta.height}`);
    }
    await contrastOk(webp, "#ffffff", "#0a0a0a");
    writeFileSync(path.join(PREVIEW_DIR, `${role}.webp`), webp);
    // PNG previews for the PR (not shipped).
    const png = await sharp(webp).png().toBuffer();
    writeFileSync(path.join(PREVIEW_DIR, `${role}.png`), png);
    urls[role] = dataUrl;
    process.stdout.write(`${role}: ${dataUrl.length} chars, q=${quality}\n`);
  }

  const body = `// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI
// Generated by editions/law/scripts/build-avatars.mjs — do not edit by hand.

export const LAW_CASE_ROLES = ["manager", "documents", "transcripts", "generator"] as const;
export type LawCaseRole = (typeof LAW_CASE_ROLES)[number];

export const LAW_ROLE_AVATARS: Record<LawCaseRole, string> = {
  manager: ${JSON.stringify(urls.manager)},
  documents: ${JSON.stringify(urls.documents)},
  transcripts: ${JSON.stringify(urls.transcripts)},
  generator: ${JSON.stringify(urls.generator)},
};

export function lawRoleAvatar(role: string): string | undefined {
  return (LAW_ROLE_AVATARS as Record<string, string>)[role];
}

export function isLawCaseRole(role: string): role is LawCaseRole {
  return (LAW_CASE_ROLES as readonly string[]).includes(role);
}
`;
  writeFileSync(OUT_TS, body);
  process.stdout.write(`Wrote ${path.relative(ROOT, OUT_TS)}\n`);
}

await main();
