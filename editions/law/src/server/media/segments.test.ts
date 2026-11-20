// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { describe, expect, it } from "vitest";
import {
  dropEmptyAndLoops,
  formatClock,
  formatSrt,
  formatSrtTime,
  formatTranscriptBody,
  formatVtt,
  formatVttTime,
  mergeSegments,
  parseAsrJsonl,
} from "./segments.js";

describe("dropEmptyAndLoops", () => {
  it("drops empty text", () => {
    expect(
      dropEmptyAndLoops([
        { startMs: 0, endMs: 100, text: " a " },
        { startMs: 100, endMs: 200, text: "  " },
        { startMs: 200, endMs: 300, text: "b" },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 100, text: "a" },
      { startMs: 200, endMs: 300, text: "b" },
    ]);
  });

  it("keeps a run of two identical lines", () => {
    expect(
      dropEmptyAndLoops([
        { startMs: 0, endMs: 1, text: "hi" },
        { startMs: 1, endMs: 2, text: "hi" },
      ]),
    ).toHaveLength(2);
  });

  it("collapses a run of three or more identical lines to the first", () => {
    expect(
      dropEmptyAndLoops([
        { startMs: 0, endMs: 1, text: "loop" },
        { startMs: 1, endMs: 2, text: "loop" },
        { startMs: 2, endMs: 3, text: "loop" },
        { startMs: 3, endMs: 4, text: "loop" },
        { startMs: 4, endMs: 5, text: "next" },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 1, text: "loop" },
      { startMs: 4, endMs: 5, text: "next" },
    ]);
  });
});

describe("mergeSegments", () => {
  it.each([
    {
      name: "merges short adjacent lines within gap and char limits",
      input: [
        { startMs: 0, endMs: 500, text: "Hello" },
        { startMs: 600, endMs: 1200, text: "world" },
      ],
      options: { maxChars: 400, maxGapMs: 700, maxDurationMs: 30_000 },
      expected: [{ startMs: 0, endMs: 1200, text: "Hello world" }],
    },
    {
      name: "does not merge across a large gap",
      input: [
        { startMs: 0, endMs: 500, text: "Hello" },
        { startMs: 2000, endMs: 2500, text: "world" },
      ],
      options: { maxGapMs: 700 },
      expected: [
        { startMs: 0, endMs: 500, text: "Hello" },
        { startMs: 2000, endMs: 2500, text: "world" },
      ],
    },
    {
      name: "does not exceed maxDurationMs",
      input: [
        { startMs: 0, endMs: 20_000, text: "a" },
        { startMs: 20_100, endMs: 35_000, text: "b" },
      ],
      options: { maxDurationMs: 30_000, maxGapMs: 700 },
      expected: [
        { startMs: 0, endMs: 20_000, text: "a" },
        { startMs: 20_100, endMs: 35_000, text: "b" },
      ],
    },
    {
      name: "does not exceed maxChars",
      input: [
        { startMs: 0, endMs: 100, text: "x".repeat(300) },
        { startMs: 150, endMs: 200, text: "y".repeat(200) },
      ],
      options: { maxChars: 400, maxGapMs: 700 },
      expected: [
        { startMs: 0, endMs: 100, text: "x".repeat(300) },
        { startMs: 150, endMs: 200, text: "y".repeat(200) },
      ],
    },
  ])("$name", ({ input, options, expected }) => {
    expect(mergeSegments(input, options)).toEqual(expected);
  });

  it("drops loops before merging", () => {
    const merged = mergeSegments(
      [
        { startMs: 0, endMs: 100, text: "same" },
        { startMs: 100, endMs: 200, text: "same" },
        { startMs: 200, endMs: 300, text: "same" },
        { startMs: 350, endMs: 400, text: "ok" },
      ],
      { maxGapMs: 700 },
    );
    expect(merged).toEqual([{ startMs: 0, endMs: 400, text: "same ok" }]);
  });
});

describe("time formats", () => {
  it("formats hh:mm:ss for the body", () => {
    expect(formatClock(0)).toBe("00:00:00");
    expect(formatClock(3_661_000)).toBe("01:01:01");
  });

  it("formats srt and vtt timestamps", () => {
    expect(formatSrtTime(3661_500)).toBe("01:01:01,500");
    expect(formatVttTime(3661_500)).toBe("01:01:01.500");
  });

  it("builds body, srt, and vtt documents", () => {
    const segments = [
      { startMs: 0, endMs: 1500, text: "One" },
      { startMs: 2000, endMs: 3500, text: "Two" },
    ];
    expect(formatTranscriptBody(segments)).toBe("[00:00:00] One\n[00:00:02] Two");
    expect(formatSrt(segments)).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\nOne\n\n2\n00:00:02,000 --> 00:00:03,500\nTwo\n",
    );
    expect(formatVtt(segments)).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nOne\n\n00:00:02.000 --> 00:00:03.500\nTwo\n",
    );
  });
});

describe("parseAsrJsonl", () => {
  it("parses segments and the done line", () => {
    const jsonl = [
      JSON.stringify({ start: 0.0, end: 1.5, text: " Hello " }),
      JSON.stringify({ start: 1.5, end: 3.0, text: "world" }),
      JSON.stringify({ done: true, language: "en", duration: 3.0 }),
    ].join("\n");
    const parsed = parseAsrJsonl(jsonl);
    expect(parsed.language).toBe("en");
    expect(parsed.durationSec).toBe(3);
    expect(parsed.segments).toEqual([
      { startMs: 0, endMs: 1500, text: " Hello " },
      { startMs: 1500, endMs: 3000, text: "world" },
    ]);
  });
});
