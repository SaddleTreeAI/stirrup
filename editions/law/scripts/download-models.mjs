#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI
/**
 * Download CTranslate2 Whisper weights for the law media sidecar.
 *
 * Repository ids come from faster-whisper 1.2.1 `_MODELS` in
 * faster_whisper/utils.py — do not invent names.
 *
 *   pnpm --filter @rakazo/edition-law media:models -- --yes
 *
 * Never run from CI or at transcription time (runtime sets HF_HUB_OFFLINE=1).
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** faster-whisper 1.2.1 `_MODELS` entries we ship by default. */
const MODELS = {
  small: "Systran/faster-whisper-small",
  "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
};

const FASTER_WHISPER_PIN = "1.2.1";

function usage() {
  console.log(`Usage: media:models --yes [--dir <path>] [--only <name>]

Downloads CTranslate2 Whisper models for local transcription.

  --yes          Required. Confirm the download.
  --dir <path>   Target root (default: $LAW_MODELS_DIR or /models)
  --only <name>  One of: ${Object.keys(MODELS).join(", ")} (default: both)

Pinned faster-whisper: ${FASTER_WHISPER_PIN}
Repos (from faster_whisper/utils.py _MODELS):
${Object.entries(MODELS)
  .map(([name, repo]) => `  ${name} → ${repo}`)
  .join("\n")}
`);
}

function parseArgs(argv) {
  const out = { yes: false, dir: process.env.LAW_MODELS_DIR?.trim() || "/models", only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") out.yes = true;
    else if (arg === "--dir") out.dir = argv[++i] ?? out.dir;
    else if (arg === "--only") out.only = argv[++i] ?? null;
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
      process.exit(1);
    }
  }
  return out;
}

function run(cmd, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

async function dirSizeBytes(root) {
  let total = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        try {
          total += (await stat(full)).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(root);
  return total;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selected = args.only ? { [args.only]: MODELS[args.only] } : { ...MODELS };
  if (args.only && !MODELS[args.only]) {
    console.error(`Unknown model '${args.only}'. Choose: ${Object.keys(MODELS).join(", ")}`);
    process.exit(1);
  }

  console.log("Will download into:", path.resolve(args.dir));
  for (const [name, repo] of Object.entries(selected)) {
    console.log(`  ${name} → https://huggingface.co/${repo}`);
  }
  console.log(`faster-whisper pin: ${FASTER_WHISPER_PIN}`);
  console.log("Licenses: faster-whisper, CTranslate2, and Whisper weights are MIT.");

  if (!args.yes) {
    console.error("\nRefusing without --yes. Re-run with --yes after reviewing the list.");
    process.exit(1);
  }

  await mkdir(args.dir, { recursive: true });

  const python =
    process.env.LAW_VENV_PYTHON?.trim() ||
    ((await pathExists("/opt/law-venv/bin/python3")) ? "/opt/law-venv/bin/python3" : "python3");

  // Ensure huggingface_hub is available (already a faster-whisper dependency in the image).
  for (const [name, repo] of Object.entries(selected)) {
    const target = path.join(args.dir, name);
    console.log(`\nDownloading ${name} → ${target}`);
    await mkdir(target, { recursive: true });
    const script = `
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id=${JSON.stringify(repo)},
    local_dir=${JSON.stringify(target)},
    local_dir_use_symlinks=False,
    allow_patterns=["config.json","preprocessor_config.json","model.bin","tokenizer.json","vocabulary.*"],
)
print("ok")
`;
    await run(python, ["-c", script]);
    const size = await dirSizeBytes(target);
    console.log(`  size on disk: ${formatBytes(size)}`);
  }
  console.log("\nDone. Set LAW_MODELS_DIR to", path.resolve(args.dir));
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
