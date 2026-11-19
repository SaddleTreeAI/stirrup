// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

/** One timed transcript line before or after merge. */
export type TranscriptSegment = {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string | null;
};

export type MergeSegmentsOptions = {
  maxChars?: number;
  maxGapMs?: number;
  maxDurationMs?: number;
};

const DEFAULT_MAX_CHARS = 400;
const DEFAULT_MAX_GAP_MS = 700;
const DEFAULT_MAX_DURATION_MS = 30_000;

/**
 * Drop empty segments. When the same text appears three or more times in a
 * row, keep only the first (Whisper repeat-loop guard).
 */
export function dropEmptyAndLoops(segments: TranscriptSegment[]): TranscriptSegment[] {
  const nonEmpty: TranscriptSegment[] = [];
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    nonEmpty.push({ ...segment, text });
  }

  const out: TranscriptSegment[] = [];
  let i = 0;
  while (i < nonEmpty.length) {
    const text = nonEmpty[i]!.text;
    let j = i + 1;
    while (j < nonEmpty.length && nonEmpty[j]!.text === text) j += 1;
    const run = j - i;
    if (run >= 3) {
      out.push(nonEmpty[i]!);
    } else {
      for (let k = i; k < j; k += 1) out.push(nonEmpty[k]!);
    }
    i = j;
  }
  return out;
}

/**
 * Merge short consecutive segments so none exceeds maxDurationMs / maxChars,
 * and gaps larger than maxGapMs start a new segment.
 */
export function mergeSegments(
  segments: TranscriptSegment[],
  options: MergeSegmentsOptions = {},
): TranscriptSegment[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxGapMs = options.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;

  const cleaned = dropEmptyAndLoops(segments);
  if (cleaned.length === 0) return [];

  const merged: TranscriptSegment[] = [];
  let current: TranscriptSegment = { ...cleaned[0]! };

  for (let i = 1; i < cleaned.length; i += 1) {
    const next = cleaned[i]!;
    const gap = next.startMs - current.endMs;
    const combinedText = `${current.text} ${next.text}`.trim();
    const combinedDuration = next.endMs - current.startMs;
    const sameSpeaker = (current.speaker ?? null) === (next.speaker ?? null);
    const canMerge =
      sameSpeaker &&
      gap >= 0 &&
      gap <= maxGapMs &&
      combinedText.length <= maxChars &&
      combinedDuration <= maxDurationMs;

    if (canMerge) {
      current = {
        startMs: current.startMs,
        endMs: Math.max(current.endMs, next.endMs),
        text: combinedText,
        speaker: current.speaker,
      };
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);
  return merged;
}

/** Format milliseconds as [hh:mm:ss] for the document body. */
export function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

/** Body lines: `[hh:mm:ss] text` per segment. */
export function formatTranscriptBody(segments: TranscriptSegment[]): string {
  return segments.map((s) => `[${formatClock(s.startMs)}] ${s.text}`).join("\n");
}

/** SubRip (.srt) export. */
export function formatSrt(segments: TranscriptSegment[]): string {
  return segments
    .map((s, i) => {
      const n = i + 1;
      return `${n}\n${formatSrtTime(s.startMs)} --> ${formatSrtTime(s.endMs)}\n${s.text}\n`;
    })
    .join("\n");
}

/** WebVTT (.vtt) export. */
export function formatVtt(segments: TranscriptSegment[]): string {
  const cues = segments
    .map((s) => `${formatVttTime(s.startMs)} --> ${formatVttTime(s.endMs)}\n${s.text}\n`)
    .join("\n");
  return `WEBVTT\n\n${cues}`;
}

export function formatSrtTime(ms: number): string {
  const { h, m, s, millis } = splitMs(ms);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(millis)}`;
}

export function formatVttTime(ms: number): string {
  const { h, m, s, millis } = splitMs(ms);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad3(millis)}`;
}

function splitMs(ms: number): { h: number; m: number; s: number; millis: number } {
  const total = Math.max(0, Math.round(ms));
  const millis = total % 1000;
  const totalSec = Math.floor(total / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return { h, m, s, millis };
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function pad3(n: number): string {
  return n.toString().padStart(3, "0");
}

/** Parse ASR JSONL into segments (ignores the final done line). */
export function parseAsrJsonl(jsonl: string): {
  segments: TranscriptSegment[];
  language?: string;
  durationSec?: number;
} {
  const segments: TranscriptSegment[] = [];
  let language: string | undefined;
  let durationSec: number | undefined;
  for (const raw of jsonl.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const row = parsed as Record<string, unknown>;
    if (row.done === true) {
      if (typeof row.language === "string") language = row.language;
      if (typeof row.duration === "number") durationSec = row.duration;
      continue;
    }
    if (typeof row.start !== "number" || typeof row.end !== "number") continue;
    const text = typeof row.text === "string" ? row.text : "";
    segments.push({
      startMs: Math.round(row.start * 1000),
      endMs: Math.round(row.end * 1000),
      text,
    });
  }
  return { segments, language, durationSec };
}
