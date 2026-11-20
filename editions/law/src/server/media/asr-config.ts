// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { cpus } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AsrEngine = "faster-whisper" | "whisper-cpp";

export type AsrConfig = {
  engine: AsrEngine;
  /** Resolved model name (e.g. large-v3-turbo or small). */
  model: string;
  /** Absolute path to the model directory under LAW_MODELS_DIR. */
  modelDir: string;
  device: "cpu" | "cuda";
  computeType: string;
  language: string;
  modelsRoot: string;
  scriptPath: string;
  maxMinutes: number;
};

export const MISSING_MODELS_MESSAGE = "Run media:models once";

export const MACHINE_TRANSCRIPT_DETAIL =
  "Machine transcript. Not a certified transcript; check against the recording.";

export const WAITING_TO_TRANSCRIBE = "Waiting to transcribe";

/** Default max media length (hours → minutes): 6 hours. */
export const DEFAULT_MAX_MINUTES = 360;

export const PROGRESS_THROTTLE_MS = 5_000;

export const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;

/** Path to media-tools/asr.py next to this package. */
export function defaultAsrScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../media-tools/asr.py");
}

export function resolveAsrConfig(
  env: NodeJS.ProcessEnv = process.env,
  options?: { hasCuda?: boolean; cpuCount?: number; scriptPath?: string },
): AsrConfig {
  const modelsRoot = env.LAW_MODELS_DIR?.trim() || "/models";
  const engineRaw = (env.LAW_ASR_ENGINE?.trim() || "faster-whisper").toLowerCase();
  const engine: AsrEngine = engineRaw === "whisper-cpp" ? "whisper-cpp" : "faster-whisper";

  const hasCuda = options?.hasCuda ?? false;
  const cpuCount = options?.cpuCount ?? cpus().length;

  const deviceRaw = (env.LAW_ASR_DEVICE?.trim() || "auto").toLowerCase();
  let device: "cpu" | "cuda";
  if (deviceRaw === "cuda") device = "cuda";
  else if (deviceRaw === "cpu") device = "cpu";
  else device = hasCuda ? "cuda" : "cpu";

  const modelRaw = env.LAW_ASR_MODEL?.trim() || "auto";
  let model: string;
  if (modelRaw === "auto") {
    model = device === "cuda" || cpuCount >= 8 ? "large-v3-turbo" : "small";
  } else {
    model = modelRaw;
  }

  const computeRaw = (env.LAW_ASR_COMPUTE?.trim() || "auto").toLowerCase();
  let computeType: string;
  if (computeRaw === "auto") {
    computeType = device === "cuda" ? "float16" : "int8";
  } else {
    computeType = computeRaw;
  }

  const language = env.LAW_ASR_LANGUAGE?.trim() || "auto";
  const maxMinutesRaw = Number(env.LAW_MEDIA_MAX_MINUTES ?? DEFAULT_MAX_MINUTES);
  const maxMinutes =
    Number.isFinite(maxMinutesRaw) && maxMinutesRaw > 0
      ? Math.floor(maxMinutesRaw)
      : DEFAULT_MAX_MINUTES;

  return {
    engine,
    model,
    modelDir: path.join(modelsRoot, model),
    device,
    computeType,
    language,
    modelsRoot,
    scriptPath: options?.scriptPath ?? (env.LAW_ASR_SCRIPT?.trim() || defaultAsrScriptPath()),
    maxMinutes,
  };
}

/** Model repository ids from faster-whisper 1.2.1 `_MODELS` (utils.py). */
export const FASTER_WHISPER_MODEL_REPOS: Record<string, string> = {
  small: "Systran/faster-whisper-small",
  "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
};
