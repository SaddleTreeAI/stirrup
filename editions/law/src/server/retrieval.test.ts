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
});
