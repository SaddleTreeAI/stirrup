// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { describe, expect, it } from "vitest";
import { formatLawContext, retrieveCaseSnippets } from "./retrieval.js";

const ward = {
  title: "Lab report",
  body: "Item W-4 was caffeine and acetaminophen, not a controlled substance.",
};
const nunez = {
  title: "Plea offer",
  body: "The plea offer for Priya Nunez mentions Bates CW-0847 and a photo array.",
};

describe("keyword retrieval", () => {
  it("returns only documents that share a keyword with the question", () => {
    const hits = retrieveCaseSnippets("Was item W-4 caffeine?", [ward, nunez]);
    expect(hits.map((hit) => hit.title)).toEqual(["Lab report"]);
    expect(hits[0]?.excerpt).toContain("caffeine");
    expect(hits[0]?.excerpt).not.toContain("CW-0847");
  });

  it("returns nothing when the question has no usable words", () => {
    expect(retrieveCaseSnippets("a to", [ward])).toEqual([]);
  });

  it("formats one case and leaves the other case's text out", () => {
    const text = formatLawContext({
      name: "Commonwealth v. Ward",
      brief: "Ward brief only.",
      snippets: retrieveCaseSnippets("caffeine acetaminophen", [ward, nunez]),
    });
    expect(text).toContain("Commonwealth v. Ward");
    expect(text).toContain("caffeine");
    expect(text).not.toContain("Nunez");
    expect(text).not.toContain("CW-0847");
  });

  it("always lists the library manifest and processing count", () => {
    const text = formatLawContext({
      name: "Commonwealth v. Ward",
      brief: "Ward brief.",
      snippets: [],
      manifest: [
        {
          id: "pdf-1",
          filename: "report.pdf",
          type: "application/pdf",
          pageCount: 15,
        },
        {
          id: "note-1",
          filename: "notes.txt",
          type: "text/plain",
          pageCount: null,
        },
      ],
      processingCount: 2,
    });
    expect(text).toContain("report.pdf (application/pdf, 15 pages) id=pdf-1");
    expect(text).toContain("notes.txt (text/plain) id=note-1");
    expect(text).toContain("2 files still processing");
  });

  it("labels PDF snippets with a physical page from page rows", () => {
    const pdf = {
      title: "Lab report",
      body: "\n\n[page 1]\n\ncover\n\n[page 2]\n\nItem W-4 was caffeine and acetaminophen.\n\n[page 3]\n\nclosing",
      pages: [
        { page: 1, text: "cover sheet only" },
        { page: 2, text: "Item W-4 was caffeine and acetaminophen." },
        { page: 3, text: "closing remarks" },
      ],
    };
    const hits = retrieveCaseSnippets("Was item caffeine?", [pdf]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe("Lab report (p. 2)");
    const text = formatLawContext({
      name: "Commonwealth v. Ward",
      brief: "Ward brief.",
      snippets: hits,
    });
    expect(text).toContain("### Lab report (p. 2)");
  });

  it("marks OCR page hits so a bot can hedge", () => {
    const pdf = {
      title: "Lab report",
      body: "\n\n[page 2]\n\nItem W-4 was caffeine and acetaminophen.",
      pages: [
        { page: 1, text: "cover sheet only", ocr: false },
        { page: 2, text: "Item W-4 was caffeine and acetaminophen.", ocr: true },
      ],
    };
    const hits = retrieveCaseSnippets("Was item caffeine?", [pdf]);
    expect(hits[0]?.title).toBe("Lab report (p. 2) (OCR)");
  });
});
