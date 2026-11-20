// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MISSING_MODELS_MESSAGE } from "../asr-config.js";
import type { HandlerContext, LawJobRow, Runner } from "../types.js";
import {
  asrPythonArgs,
  createProgressThrottler,
  createTranscribeHandler,
  durationMsFromProbe,
  ffmpegExtractArgs,
  ffprobeArgs,
  hasAudioStream,
  parseProgressLine,
} from "./transcribe.js";

function job(overrides: Partial<LawJobRow> = {}): LawJobRow {
  const now = new Date();
  return {
    id: "job-1",
    caseId: "case-1",
    documentId: "doc-1",
    kind: "transcribe",
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    error: "",
    payload: {},
    runAfter: now,
    lockedAt: now,
    lockedBy: "w1",
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    ...overrides,
  };
}

const PROBE_OK = {
  format: { duration: "12.5" },
  streams: [
    { codec_type: "video", duration: "12.5" },
    { codec_type: "audio", duration: "12.5" },
  ],
};

const PROBE_NO_AUDIO = {
  format: { duration: "5.0" },
  streams: [{ codec_type: "video", duration: "5.0" }],
};

const PROBE_OVER_LIMIT = {
  format: { duration: String(400 * 60) },
  streams: [{ codec_type: "audio", duration: String(400 * 60) }],
};

const JSONL_FIXTURE = [
  JSON.stringify({ start: 0.0, end: 1.2, text: "Hello" }),
  JSON.stringify({ start: 1.3, end: 2.5, text: "world" }),
  JSON.stringify({ done: true, language: "en", duration: 2.5 }),
].join("\n");

function makePrisma(updates: unknown[] = []) {
  const segments: unknown[] = [];
  return {
    lawDocument: {
      findUnique: vi.fn(async () => ({ id: "doc-1", caseId: "case-1" })),
      update: vi.fn(async ({ data }: { data: unknown }) => {
        updates.push(data);
        return {};
      }),
    },
    lawCase: {
      findUnique: vi.fn(async () => ({ spaceId: "space-1" })),
    },
    lawTranscriptSegment: {
      deleteMany: vi.fn(async () => {
        segments.length = 0;
        return { count: 0 };
      }),
      create: vi.fn(async ({ data }: { data: unknown }) => {
        segments.push(data);
        return data;
      }),
    },
    _segments: segments,
    _updates: updates,
  };
}

describe("ffprobe / ffmpeg argv", () => {
  it("builds exact ffprobe argv", () => {
    expect(ffprobeArgs("/tmp/in.mp4")).toEqual([
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "/tmp/in.mp4",
    ]);
  });

  it("builds exact ffmpeg extract argv", () => {
    expect(ffmpegExtractArgs("/tmp/in.mp4", "/tmp/audio.wav")).toEqual([
      "-nostdin",
      "-y",
      "-i",
      "/tmp/in.mp4",
      "-vn",
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "/tmp/audio.wav",
    ]);
  });

  it("detects audio streams and duration", () => {
    expect(hasAudioStream(PROBE_OK)).toBe(true);
    expect(hasAudioStream(PROBE_NO_AUDIO)).toBe(false);
    expect(durationMsFromProbe(PROBE_OK)).toBe(12_500);
  });
});

describe("progress throttle", () => {
  it("parses progress lines", () => {
    expect(parseProgressLine("progress 42")).toBe(42);
    expect(parseProgressLine("nope")).toBeNull();
  });

  it("throttles statusDetail updates to every 5 seconds", async () => {
    let now = 0;
    const details: string[] = [];
    const throttler = createProgressThrottler(
      async (detail) => {
        details.push(detail);
      },
      5_000,
      () => now,
    );
    await throttler.onProgress(10);
    now = 1_000;
    await throttler.onProgress(20);
    now = 5_000;
    await throttler.onProgress(30);
    await throttler.flush();
    expect(details).toEqual(["Transcribing 10%", "Transcribing 30%"]);
  });
});

describe("createTranscribeHandler", () => {
  it("turns ffprobe + JSONL fixtures into sealed segments and a body", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "transcribe-"));
    const modelsDir = path.join(tmpDir, "models", "small");
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(path.join(modelsDir, "model.bin"), "x");
    const original = path.join(tmpDir, "clip.mp4");
    writeFileSync(original, "fake");

    const updates: unknown[] = [];
    const prisma = makePrisma(updates);
    const calls: Array<{ cmd: string; args: string[] }> = [];

    const runner: Runner = {
      async run(cmd, args, options) {
        calls.push({ cmd, args });
        if (cmd === "ffprobe") {
          return { code: 0, stdout: JSON.stringify(PROBE_OK), stderr: "" };
        }
        if (cmd === "nvidia-smi") {
          return { code: 127, stdout: "", stderr: "" };
        }
        if (cmd === "ffmpeg") {
          writeFileSync(path.join(tmpDir, "audio.wav"), "wav");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (cmd === "python3") {
          await options?.onStdout?.("progress 10\n");
          await options?.onStdout?.("progress 90\n");
          const outIdx = args.indexOf("--out");
          const outPath = args[outIdx + 1]!;
          writeFileSync(outPath, JSONL_FIXTURE);
          return { code: 0, stdout: "progress 100\n", stderr: "" };
        }
        return { code: 127, stdout: "", stderr: "unknown" };
      },
    };

    const handler = createTranscribeHandler({
      env: {
        LAW_MODELS_DIR: path.join(tmpDir, "models"),
        LAW_ASR_MODEL: "small",
        LAW_ASR_DEVICE: "cpu",
        LAW_MEDIA_MAX_MINUTES: "360",
      },
      resolveConfig: (env) => ({
        engine: "faster-whisper",
        model: "small",
        modelDir: path.join(env.LAW_MODELS_DIR!, "small"),
        device: "cpu",
        computeType: "int8",
        language: "auto",
        modelsRoot: env.LAW_MODELS_DIR!,
        scriptPath: "/opt/law-media-tools/asr.py",
        maxMinutes: 360,
      }),
    });

    const ctx: HandlerContext = {
      job: job(),
      prisma: prisma as never,
      runner,
      tmpDir,
      readOriginal: async () => original,
      saveArtifact: async () => ({ id: "art" }),
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };

    await handler(ctx);

    expect(calls.find((c) => c.cmd === "ffprobe")?.args).toEqual(ffprobeArgs(original));
    expect(calls.find((c) => c.cmd === "ffmpeg")?.args).toEqual(
      ffmpegExtractArgs(original, path.join(tmpDir, "audio.wav")),
    );
    const py = calls.find((c) => c.cmd === "python3");
    expect(py?.args).toEqual(
      asrPythonArgs(
        {
          engine: "faster-whisper",
          model: "small",
          modelDir: path.join(tmpDir, "models", "small"),
          device: "cpu",
          computeType: "int8",
          language: "auto",
          modelsRoot: path.join(tmpDir, "models"),
          scriptPath: "/opt/law-media-tools/asr.py",
          maxMinutes: 360,
        },
        path.join(tmpDir, "audio.wav"),
        path.join(tmpDir, "segments.jsonl"),
      ),
    );

    expect(prisma.lawTranscriptSegment.create).toHaveBeenCalled();
    expect(prisma._segments).toHaveLength(1);
    expect(prisma._segments[0]).toMatchObject({
      documentId: "doc-1",
      idx: 0,
      startMs: 0,
      endMs: 2500,
      speaker: null,
    });
    expect((prisma._segments[0] as { text: string }).text).toBe("Hello world");

    const ready = updates.find(
      (u) => u && typeof u === "object" && (u as { status?: string }).status === "ready",
    ) as { body: string; statusDetail: string; durationMs: number };
    expect(ready.statusDetail).toBe(
      "Machine transcript. Not a certified transcript; check against the recording.",
    );
    expect(ready.body).toBe("[00:00:00] Hello world");
    expect(ready.durationMs).toBe(12_500);
  });

  it("rejects when there is no audio stream", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "transcribe-"));
    const runner: Runner = {
      async run(cmd) {
        if (cmd === "ffprobe") {
          return { code: 0, stdout: JSON.stringify(PROBE_NO_AUDIO), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const handler = createTranscribeHandler({
      env: { LAW_MODELS_DIR: tmpDir, LAW_ASR_MODEL: "small" },
    });
    await expect(
      handler({
        job: job(),
        prisma: makePrisma() as never,
        runner,
        tmpDir,
        readOriginal: async () => path.join(tmpDir, "x"),
        saveArtifact: async () => ({ id: "a" }),
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
    ).rejects.toThrow(/No audio stream/);
  });

  it("rejects over-limit duration", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "transcribe-"));
    const modelsDir = path.join(tmpDir, "models", "small");
    mkdirSync(modelsDir, { recursive: true });
    const runner: Runner = {
      async run(cmd) {
        if (cmd === "ffprobe") {
          return { code: 0, stdout: JSON.stringify(PROBE_OVER_LIMIT), stderr: "" };
        }
        if (cmd === "nvidia-smi") return { code: 127, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const handler = createTranscribeHandler({
      env: {
        LAW_MODELS_DIR: path.join(tmpDir, "models"),
        LAW_ASR_MODEL: "small",
        LAW_MEDIA_MAX_MINUTES: "360",
      },
      resolveConfig: (env) => ({
        engine: "faster-whisper",
        model: "small",
        modelDir: path.join(env.LAW_MODELS_DIR!, "small"),
        device: "cpu",
        computeType: "int8",
        language: "auto",
        modelsRoot: env.LAW_MODELS_DIR!,
        scriptPath: "/tmp/asr.py",
        maxMinutes: 360,
      }),
    });
    await expect(
      handler({
        job: job(),
        prisma: makePrisma() as never,
        runner,
        tmpDir,
        readOriginal: async () => path.join(tmpDir, "x"),
        saveArtifact: async () => ({ id: "a" }),
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
    ).rejects.toThrow(/Media too long/);
  });

  it("fails with the exact operator instruction when models are missing", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "transcribe-"));
    const runner: Runner = {
      async run(cmd) {
        if (cmd === "ffprobe") {
          return { code: 0, stdout: JSON.stringify(PROBE_OK), stderr: "" };
        }
        if (cmd === "nvidia-smi") return { code: 127, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const handler = createTranscribeHandler({
      env: { LAW_MODELS_DIR: path.join(tmpDir, "missing-models"), LAW_ASR_MODEL: "small" },
      resolveConfig: (env) => ({
        engine: "faster-whisper",
        model: "small",
        modelDir: path.join(env.LAW_MODELS_DIR!, "small"),
        device: "cpu",
        computeType: "int8",
        language: "auto",
        modelsRoot: env.LAW_MODELS_DIR!,
        scriptPath: "/tmp/asr.py",
        maxMinutes: 360,
      }),
    });
    await expect(
      handler({
        job: job(),
        prisma: makePrisma() as never,
        runner,
        tmpDir,
        readOriginal: async () => path.join(tmpDir, "x"),
        saveArtifact: async () => ({ id: "a" }),
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
    ).rejects.toThrow(MISSING_MODELS_MESSAGE);
  });

  it("rejects when ffprobe fails", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "transcribe-"));
    const runner: Runner = {
      async run(cmd) {
        if (cmd === "ffprobe") return { code: 1, stdout: "", stderr: "fail" };
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    await expect(
      createTranscribeHandler()({
        job: job(),
        prisma: makePrisma() as never,
        runner,
        tmpDir,
        readOriginal: async () => path.join(tmpDir, "x"),
        saveArtifact: async () => ({ id: "a" }),
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
    ).rejects.toThrow(/Couldn't read media/);
  });
});
