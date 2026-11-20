// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { readdir } from "node:fs/promises";
import { createProcessRunner } from "./runner.js";
import type { Runner } from "./types.js";

export type DoctorTool = {
  id: string;
  /** Executable name on PATH. */
  command: string;
  args: string[];
  /** How to pull a version string from combined stdout/stderr. */
  parseVersion: (output: string) => string | undefined;
  required?: boolean;
  /** Some tools (pdftotext -v) print the version and exit non-zero. */
  allowNonZero?: boolean;
};

export type DoctorLine = {
  id: string;
  status: "ok" | "MISSING";
  detail: string;
  required: boolean;
};

export const DEFAULT_REQUIRED_TOOLS = [
  "ffmpeg",
  "ffprobe",
  "pdftotext",
  "tesseract",
  "ocrmypdf",
  "python3",
] as const;

export const MEDIA_TOOLS: DoctorTool[] = [
  {
    id: "ffmpeg",
    command: "ffmpeg",
    args: ["-version"],
    parseVersion: (out) => out.match(/ffmpeg version\s+(\S+)/i)?.[1],
  },
  {
    id: "ffprobe",
    command: "ffprobe",
    args: ["-version"],
    parseVersion: (out) => out.match(/ffprobe version\s+(\S+)/i)?.[1],
  },
  {
    id: "pdftotext",
    command: "pdftotext",
    args: ["-v"],
    parseVersion: (out) => out.match(/version\s+(\S+)/i)?.[1],
    allowNonZero: true,
  },
  {
    id: "tesseract",
    command: "tesseract",
    args: ["--version"],
    parseVersion: (out) => out.match(/tesseract\s+(\S+)/i)?.[1],
  },
  {
    id: "ocrmypdf",
    command: "ocrmypdf",
    args: ["--version"],
    parseVersion: (out) => out.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1],
  },
  {
    id: "python3",
    command: "python3",
    args: ["--version"],
    parseVersion: (out) => out.match(/Python\s+(\S+)/i)?.[1],
  },
  // V1 adds faster-whisper into the venv; listed here so doctor already knows the id.
  {
    id: "faster-whisper",
    command: "python3",
    args: ["-c", "import faster_whisper; print(faster_whisper.__version__)"],
    parseVersion: (out) => out.trim().split(/\s+/).pop(),
    required: false,
  },
];

export function requiredToolIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.LAW_MEDIA_REQUIRED_TOOLS?.trim();
  if (!raw) return new Set(DEFAULT_REQUIRED_TOOLS);
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export async function checkTool(
  tool: DoctorTool,
  runner: Runner,
  required: boolean,
): Promise<DoctorLine> {
  const result = await runner.run(tool.command, tool.args, { timeoutMs: 15_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  // Spawn failures (ENOENT) come back with code null — never treat as a version.
  if (result.code === null) {
    return { id: tool.id, status: "MISSING", detail: "MISSING", required };
  }
  if (result.code !== 0 && !tool.allowNonZero) {
    return { id: tool.id, status: "MISSING", detail: "MISSING", required };
  }
  const version = tool.parseVersion(output);
  if (!version) {
    return { id: tool.id, status: "MISSING", detail: "MISSING", required };
  }
  return { id: tool.id, status: "ok", detail: version, required };
}

export async function checkGpu(runner: Runner): Promise<DoctorLine> {
  const result = await runner.run("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], {
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    return { id: "gpu", status: "MISSING", detail: "MISSING", required: false };
  }
  const name = result.stdout.trim().split("\n")[0]?.trim();
  if (!name) return { id: "gpu", status: "MISSING", detail: "MISSING", required: false };
  return { id: "gpu", status: "ok", detail: name, required: false };
}

/** List model directories under LAW_MODELS_DIR (names only; never file contents). */
export async function checkModels(env: NodeJS.ProcessEnv = process.env): Promise<DoctorLine> {
  const root = env.LAW_MODELS_DIR?.trim() || "/models";
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    if (dirs.length === 0) {
      return { id: "models", status: "MISSING", detail: `empty ${root}`, required: false };
    }
    return { id: "models", status: "ok", detail: dirs.join(","), required: false };
  } catch {
    return { id: "models", status: "MISSING", detail: `MISSING ${root}`, required: false };
  }
}

/** CUDA availability via nvidia-smi (same signal as checkGpu; labelled for ASR). */
export async function checkCuda(runner: Runner): Promise<DoctorLine> {
  const gpu = await checkGpu(runner);
  return {
    id: "cuda",
    status: gpu.status,
    detail: gpu.status === "ok" ? gpu.detail : "MISSING",
    required: false,
  };
}

export type DoctorReport = {
  lines: DoctorLine[];
  ok: boolean;
};

export async function runDoctor(options?: {
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
  tools?: DoctorTool[];
}): Promise<DoctorReport> {
  const runner = options?.runner ?? createProcessRunner();
  const env = options?.env ?? process.env;
  const required = requiredToolIds(env);
  const tools = options?.tools ?? MEDIA_TOOLS;
  const lines: DoctorLine[] = [];
  for (const tool of tools) {
    const isRequired = tool.required === false ? false : required.has(tool.id);
    lines.push(await checkTool(tool, runner, isRequired));
  }
  lines.push(await checkGpu(runner));
  lines.push(await checkCuda(runner));
  lines.push(await checkModels(env));
  const ok = lines.every((line) => line.status === "ok" || !line.required);
  return { lines, ok };
}

/** One printable line per tool: `ffmpeg 6.1.1` or `ffmpeg MISSING`. */
export function formatDoctorLines(report: DoctorReport): string[] {
  return report.lines.map((line) =>
    line.status === "ok" ? `${line.id} ${line.detail}` : `${line.id} MISSING`,
  );
}
