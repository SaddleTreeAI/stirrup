// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { cpus } from "node:os";
import path from "node:path";
import { sealLawText } from "../../seal.js";
import type { AsrConfig } from "../asr-config.js";
import {
  FFMPEG_TIMEOUT_MS,
  MACHINE_TRANSCRIPT_DETAIL,
  MISSING_MODELS_MESSAGE,
  PROGRESS_THROTTLE_MS,
  resolveAsrConfig,
} from "../asr-config.js";
import type { TranscriptSegment } from "../segments.js";
import { formatTranscriptBody, mergeSegments, parseAsrJsonl } from "../segments.js";
import type { Handler, HandlerContext, Runner } from "../types.js";

const SEGMENT_BATCH = 50;

export type FfprobeStream = {
  codec_type?: string;
  duration?: string;
};

export type FfprobeJson = {
  format?: { duration?: string };
  streams?: FfprobeStream[];
};

/** Probe argv (exact): never shell, never user-controlled strings. */
export function ffprobeArgs(inputPath: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", inputPath];
}

/** Extract mono 16 kHz PCM WAV argv (exact). */
export function ffmpegExtractArgs(inputPath: string, wavPath: string): string[] {
  return [
    "-nostdin",
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    wavPath,
  ];
}

export function asrPythonArgs(config: AsrConfig, wavPath: string, outPath: string): string[] {
  return [
    config.scriptPath,
    "--wav",
    wavPath,
    "--out",
    outPath,
    "--model-dir",
    config.modelDir,
    "--device",
    config.device,
    "--compute-type",
    config.computeType,
    "--language",
    config.language,
    "--engine",
    config.engine,
  ];
}

export function durationMsFromProbe(probe: FfprobeJson): number | null {
  const formatDur = probe.format?.duration;
  if (formatDur !== undefined) {
    const sec = Number(formatDur);
    if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  }
  let max = 0;
  for (const stream of probe.streams ?? []) {
    if (stream.duration === undefined) continue;
    const sec = Number(stream.duration);
    if (Number.isFinite(sec) && sec > max) max = sec;
  }
  return max > 0 ? Math.round(max * 1000) : null;
}

export function hasAudioStream(probe: FfprobeJson): boolean {
  return (probe.streams ?? []).some((s) => s.codec_type === "audio");
}

export function parseProgressLine(line: string): number | null {
  const match = line.trim().match(/^progress\s+(\d{1,3})\s*$/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.floor(value)));
}

/**
 * Throttle statusDetail updates to at most once every `intervalMs`.
 * Returns a function that accepts a progress percent.
 */
export function createProgressThrottler(
  update: (detail: string) => Promise<void>,
  intervalMs = PROGRESS_THROTTLE_MS,
  now: () => number = () => Date.now(),
): { onProgress: (pct: number) => Promise<void>; flush: () => Promise<void> } {
  let lastSent = 0;
  let pending: number | null = null;
  let lastWritten: number | null = null;

  const write = async (pct: number) => {
    if (lastWritten === pct) return;
    lastWritten = pct;
    lastSent = now();
    pending = null;
    await update(`Transcribing ${pct}%`);
  };

  return {
    async onProgress(pct) {
      const t = now();
      if (t - lastSent >= intervalMs || lastWritten === null) {
        await write(pct);
      } else {
        pending = pct;
      }
    },
    async flush() {
      if (pending !== null) await write(pending);
    },
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function detectCuda(runner: Runner): Promise<boolean> {
  const result = await runner.run("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], {
    timeoutMs: 5_000,
  });
  return result.code === 0 && result.stdout.trim().length > 0;
}

async function setDocumentStatus(
  ctx: HandlerContext,
  documentId: string,
  data: {
    status?: string;
    statusDetail?: string;
    durationMs?: number | null;
    body?: string;
  },
): Promise<void> {
  await ctx.prisma.lawDocument.update({
    where: { id: documentId },
    data: { ...data, updatedAt: new Date() },
  });
}

async function insertSegments(
  ctx: HandlerContext,
  documentId: string,
  spaceId: string,
  segments: TranscriptSegment[],
): Promise<void> {
  await ctx.prisma.lawTranscriptSegment.deleteMany({ where: { documentId } });
  for (let offset = 0; offset < segments.length; offset += SEGMENT_BATCH) {
    const batch = segments.slice(offset, offset + SEGMENT_BATCH);
    for (let i = 0; i < batch.length; i += 1) {
      const segment = batch[i]!;
      const idx = offset + i;
      const id = randomUUID();
      const text = await sealLawText(
        ctx.prisma,
        {
          table: "law_transcript_segments",
          column: "text",
          rowId: id,
          spaceId,
          owner: documentId,
        },
        segment.text,
      );
      await ctx.prisma.lawTranscriptSegment.create({
        data: {
          id,
          documentId,
          idx,
          startMs: segment.startMs,
          endMs: segment.endMs,
          speaker: segment.speaker ?? null,
          text,
        },
      });
    }
  }
}

export type TranscribeDeps = {
  resolveConfig?: (
    env: NodeJS.ProcessEnv,
    options: { hasCuda: boolean; cpuCount: number },
  ) => AsrConfig;
  env?: NodeJS.ProcessEnv;
  /** Inject probe/ASR results in tests without spawning tools. */
  readJsonl?: (path: string) => Promise<string>;
};

export function createTranscribeHandler(deps: TranscribeDeps = {}): Handler {
  return async (ctx) => {
    if (!ctx.job.documentId) throw new Error("document required");
    const documentId = ctx.job.documentId;
    const env = deps.env ?? process.env;

    const doc = await ctx.prisma.lawDocument.findUnique({
      where: { id: documentId },
      select: { id: true, caseId: true },
    });
    if (!doc) throw new Error("document missing");

    const lawCase = await ctx.prisma.lawCase.findUnique({
      where: { id: doc.caseId },
      select: { spaceId: true },
    });
    if (!lawCase) throw new Error("case missing");
    const spaceId = lawCase.spaceId;

    await setDocumentStatus(ctx, documentId, {
      status: "processing",
      statusDetail: "Transcribing",
    });

    const original = await ctx.readOriginal(documentId);

    // --- ffprobe ---
    const probeResult = await ctx.runner.run("ffprobe", ffprobeArgs(original), {
      timeoutMs: 60_000,
    });
    if (probeResult.code !== 0) {
      throw new Error("Couldn't read media");
    }
    let probe: FfprobeJson;
    try {
      probe = JSON.parse(probeResult.stdout) as FfprobeJson;
    } catch {
      throw new Error("Couldn't read media");
    }
    if (!hasAudioStream(probe)) {
      throw new Error("No audio stream");
    }

    const hasCuda = await detectCuda(ctx.runner);
    const config = (deps.resolveConfig ?? resolveAsrConfig)(env, {
      hasCuda,
      cpuCount: cpus().length,
    });

    const durationMs = durationMsFromProbe(probe);
    if (durationMs !== null) {
      const maxMs = config.maxMinutes * 60_000;
      if (durationMs > maxMs) {
        throw new Error("Media too long");
      }
      await setDocumentStatus(ctx, documentId, { durationMs });
    }

    if (!(await pathExists(config.modelDir))) {
      throw new Error(MISSING_MODELS_MESSAGE);
    }

    // --- ffmpeg extract ---
    const wavPath = path.join(ctx.tmpDir, "audio.wav");
    const extract = await ctx.runner.run("ffmpeg", ffmpegExtractArgs(original, wavPath), {
      timeoutMs: FFMPEG_TIMEOUT_MS,
    });
    if (extract.code !== 0) {
      throw new Error("Couldn't extract audio");
    }

    // --- ASR ---
    const jsonlPath = path.join(ctx.tmpDir, "segments.jsonl");
    const throttler = createProgressThrottler(async (detail) => {
      await setDocumentStatus(ctx, documentId, { statusDetail: detail });
    });

    const asrEnv = {
      ...env,
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      LAW_ASR_ENGINE: config.engine,
    };

    const asr = await ctx.runner.run("python3", asrPythonArgs(config, wavPath, jsonlPath), {
      timeoutMs: Math.max(FFMPEG_TIMEOUT_MS, (config.maxMinutes + 30) * 60_000),
      env: asrEnv,
      onStdout: async (chunk) => {
        for (const line of chunk.split(/\r?\n/)) {
          const pct = parseProgressLine(line);
          if (pct !== null) await throttler.onProgress(pct);
        }
      },
    });
    await throttler.flush();

    if (asr.code === 2 || asr.stderr?.includes(MISSING_MODELS_MESSAGE)) {
      throw new Error(MISSING_MODELS_MESSAGE);
    }
    if (asr.code !== 0) {
      throw new Error("Couldn't transcribe");
    }

    const jsonl =
      deps.readJsonl !== undefined
        ? await deps.readJsonl(jsonlPath)
        : await readFile(jsonlPath, "utf8");
    const parsed = parseAsrJsonl(jsonl);
    const merged = mergeSegments(parsed.segments, {
      maxChars: 400,
      maxGapMs: 700,
      maxDurationMs: 30_000,
    });

    const bodyPlain = formatTranscriptBody(merged);
    const body = await sealLawText(
      ctx.prisma,
      {
        table: "law_documents",
        column: "body",
        rowId: documentId,
        spaceId,
        owner: doc.caseId,
      },
      bodyPlain,
    );

    await insertSegments(ctx, documentId, spaceId, merged);

    await setDocumentStatus(ctx, documentId, {
      status: "ready",
      statusDetail: MACHINE_TRANSCRIPT_DETAIL,
      body,
      durationMs:
        durationMs ??
        (parsed.durationSec != null ? Math.round(parsed.durationSec * 1000) : undefined),
    });

    ctx.log.info("transcribe done", {
      jobId: ctx.job.id,
      documentId,
      segments: merged.length,
    });
  };
}

export const transcribeHandler: Handler = createTranscribeHandler();
