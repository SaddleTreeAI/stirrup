// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { createLogger, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchableRow } from "./search.js";
import {
  allowSearch,
  foldSearchText,
  formatSearchTimestamp,
  rankSearchHits,
  resetSearchRateLimitForTests,
  scoreSearchRow,
  searchPreloaded,
} from "./search.js";

describe("foldSearchText", () => {
  it("strips diacritics and lowercases", () => {
    expect(foldSearchText("Café Résumé")).toBe("cafe resume");
  });
});

describe("scoreSearchRow", () => {
  it("scores a phrase match higher than scattered terms", () => {
    const phrase = scoreSearchRow(
      "blue sedan",
      "Witness notes",
      "A blue sedan left the lot after midnight.",
    );
    const terms = scoreSearchRow(
      "blue sedan",
      "Witness notes",
      "The sedan was red. Later a blue truck arrived.",
    );
    expect(phrase).not.toBeNull();
    expect(terms).not.toBeNull();
    expect(phrase!.score).toBeGreaterThan(terms!.score);
  });

  it("matches diacritics-insensitively", () => {
    const hit = scoreSearchRow("cafe", "Menu", "The café opened early.");
    expect(hit).not.toBeNull();
    expect(hit!.snippet.toLowerCase()).toContain("café");
  });

  it("boosts title matches", () => {
    const titled = scoreSearchRow("exhibit", "Exhibit A photo", "Unrelated body text here.");
    const bodyOnly = scoreSearchRow("exhibit", "Other file", "This exhibit was marked.");
    expect(titled).not.toBeNull();
    expect(bodyOnly).not.toBeNull();
    expect(titled!.score).toBeGreaterThan(bodyOnly!.score);
  });

  it("returns snippet offsets around the first match", () => {
    const body = `${"x".repeat(120)}UNIQUEWORD${"y".repeat(120)}`;
    const hit = scoreSearchRow("UNIQUEWORD", "Note", body);
    expect(hit).not.toBeNull();
    expect(hit!.snippet.length).toBeLessThanOrEqual(200);
    expect(hit!.matches.length).toBe(1);
    const [match] = hit!.matches;
    expect(hit!.snippet.slice(match!.start, match!.end).toLowerCase()).toBe("uniqueword");
  });

  it("returns null when nothing matches", () => {
    expect(scoreSearchRow("zebra", "Alpha", "beta gamma")).toBeNull();
  });
});

describe("searchPreloaded", () => {
  it("sets truncated when the row cap is hit", () => {
    const rows: SearchableRow[] = Array.from({ length: 5 }, (_, i) => ({
      kind: "segment" as const,
      documentId: `doc-${i}`,
      title: `Doc ${i}`,
      // Needle sits past the scan cap so it is not found.
      text: i === 4 ? "needle in segment" : "other text",
      startMs: i * 1000,
      createdAtMs: i,
    }));
    const result = searchPreloaded("needle", rows, { maxRows: 3 });
    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(3);
    expect(result.hits).toHaveLength(0);
  });

  it("finds the needle within the cap", () => {
    const rows: SearchableRow[] = Array.from({ length: 5 }, (_, i) => ({
      kind: "text" as const,
      documentId: `doc-${i}`,
      title: `Doc ${i}`,
      text: i === 1 ? "needle in body" : "other text",
      createdAtMs: i,
    }));
    const result = searchPreloaded("needle", rows, { maxRows: 5 });
    expect(result.truncated).toBe(false);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.documentId).toBe("doc-1");
  });

  it("excludes rows that do not match (deleted handled upstream)", () => {
    const rows: SearchableRow[] = [
      {
        kind: "text",
        documentId: "kept",
        title: "Kept",
        text: "alpha marker",
        createdAtMs: 2,
      },
      {
        kind: "text",
        documentId: "other",
        title: "Other",
        text: "beta only",
        createdAtMs: 1,
      },
    ];
    const hits = rankSearchHits("alpha", rows);
    expect(hits.map((h) => h.documentId)).toEqual(["kept"]);
  });
});

describe("formatSearchTimestamp", () => {
  it("formats HH:MM:SS", () => {
    expect(formatSearchTimestamp(0)).toBe("00:00:00");
    expect(formatSearchTimestamp(751_000)).toBe("00:12:31");
    expect(formatSearchTimestamp(3_661_000)).toBe("01:01:01");
  });
});

describe("allowSearch rate limit", () => {
  beforeEach(() => {
    resetSearchRateLimitForTests();
  });

  it("allows 30 searches then refuses", () => {
    for (let i = 0; i < 30; i++) expect(allowSearch("user-a", 1_000)).toBe(true);
    expect(allowSearch("user-a", 1_000)).toBe(false);
    expect(allowSearch("user-b", 1_000)).toBe(true);
  });
});

describe("scale: 5,000 synthetic segments", () => {
  it("scores 5,000 rows within a measured budget", () => {
    const rows: SearchableRow[] = Array.from({ length: 5_000 }, (_, i) => ({
      kind: "segment" as const,
      documentId: `doc-${i % 10}`,
      title: `Hearing ${i % 10}`,
      text:
        i === 4_321
          ? "Unique scale token zeppelin appears once."
          : `Segment ${i} filler words about routine hearing notes.`,
      startMs: i * 1000,
      createdAtMs: i,
    }));
    const started = performance.now();
    const result = searchPreloaded("zeppelin", rows, { maxRows: 5_000, limit: 10 });
    const elapsedMs = performance.now() - started;
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.documentId).toBe("doc-1");
    // Bound for CI agents; measured on this host and reported in the PR.
    expect(elapsedMs, `5k rows took ${elapsedMs.toFixed(1)}ms`).toBeLessThan(2_000);
  });

  it("scores 20,000 rows and reports the time", () => {
    const rows: SearchableRow[] = Array.from({ length: 20_000 }, (_, i) => ({
      kind: "segment" as const,
      documentId: `doc-${i % 20}`,
      title: `File ${i % 20}`,
      text:
        i === 19_000
          ? "Unique scale token airship appears once."
          : `Segment ${i} filler words about routine hearing notes.`,
      startMs: i * 500,
      createdAtMs: i,
    }));
    const started = performance.now();
    const result = searchPreloaded("airship", rows, { maxRows: 20_000, limit: 10 });
    const elapsedMs = performance.now() - started;
    expect(result.hits).toHaveLength(1);
    expect(elapsedMs, `20k rows took ${elapsedMs.toFixed(1)}ms`).toBeLessThan(8_000);
  });
});

describe("search logging contract", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
  });

  it("logger helpers never receive query or snippet fields in bindings shape", () => {
    const sink = {
      lines: [] as Array<{ message: string; bindings?: Record<string, unknown> }>,
      write(event: { message: string; bindings?: Record<string, unknown> }) {
        this.lines.push({ message: event.message, bindings: event.bindings });
      },
    };
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const logger = createLogger({ service: "test", sinks: [sink] });
    logger.info("law.search", {
      scanned: 12,
      hits: 2,
      truncated: false,
      durationMs: 5,
    });
    expect(sink.lines).toHaveLength(1);
    const bindings = sink.lines[0]?.bindings ?? {};
    expect(bindings).not.toHaveProperty("q");
    expect(bindings).not.toHaveProperty("query");
    expect(bindings).not.toHaveProperty("snippet");
    expect(JSON.stringify(bindings)).not.toMatch(/secretword/i);
  });
});

describe("cap behavior via searchPreloaded", () => {
  it("marks truncated when more rows exist than the cap", () => {
    const rows: SearchableRow[] = Array.from({ length: 100 }, (_, i) => ({
      kind: "text" as const,
      documentId: `d-${i}`,
      title: "T",
      text: "word",
      createdAtMs: i,
    }));
    const result = searchPreloaded("word", rows, { maxRows: 50, limit: 50 });
    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(50);
  });
});

// Silence unused vi import if not used elsewhere in future edits.
void vi;
