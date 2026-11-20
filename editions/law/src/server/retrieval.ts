// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

export interface LawSnippetPage {
  page: number;
  text: string;
}

export interface LawSnippetSource {
  title: string;
  body: string;
  /** Physical page rows for PDFs; labels cite these, not printed page numbers. */
  pages?: readonly LawSnippetPage[];
}

export interface LawSnippet {
  title: string;
  excerpt: string;
}

const STOP = new Set([
  "that",
  "this",
  "with",
  "from",
  "have",
  "were",
  "been",
  "they",
  "their",
  "about",
  "into",
  "your",
  "case",
  "said",
  "then",
  "than",
]);

/** Words long enough to match a case file. No stemming and no vectors. */
export function lawKeywords(text: string): string[] {
  const words = text.toLowerCase().split(/[^a-z0-9]+/);
  return [...new Set(words.filter((word) => word.length > 3 && !STOP.has(word)))];
}

/**
 * Rank this case's documents by shared keywords and return a short excerpt from each hit.
 * Documents that share no keyword are left out, so another case's file cannot appear.
 * PDF hits label the source with a physical page number from page rows when present.
 */
export function retrieveCaseSnippets(
  query: string,
  docs: readonly LawSnippetSource[],
  limit = 3,
): LawSnippet[] {
  const terms = lawKeywords(query);
  if (terms.length === 0 || docs.length === 0) return [];
  return docs
    .map((doc) => {
      const haystack = `${doc.title}\n${doc.body}`.toLowerCase();
      let score = 0;
      for (const term of terms) if (haystack.includes(term)) score += 1;
      return { doc, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title))
    .slice(0, limit)
    .map(({ doc }) => {
      const excerpt = excerptAround(doc.body, terms);
      const page = pageForHit(doc.pages, excerpt, terms);
      const title = page !== undefined ? `${doc.title} (p. ${page})` : doc.title;
      return { title, excerpt };
    });
}

export function formatLawContext(input: {
  name: string;
  brief: string;
  snippets: readonly LawSnippet[];
}): string {
  const retrieved = input.snippets
    .map((snippet) => `### ${snippet.title}\n${snippet.excerpt}`)
    .join("\n\n");
  return [
    `Case: ${input.name}`,
    `Brief:\n${input.brief}`,
    retrieved ? `Retrieved case documents:\n${retrieved}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function excerptAround(body: string, terms: readonly string[]): string {
  const lower = body.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  const start = at < 0 ? 0 : Math.max(0, at - 80);
  return body.slice(start, start + 420).trim();
}

/** Prefer the page row that holds the excerpt; fall back to the first keyword hit. */
function pageForHit(
  pages: readonly LawSnippetPage[] | undefined,
  excerpt: string,
  terms: readonly string[],
): number | undefined {
  if (!pages || pages.length === 0) return undefined;
  const needle = excerpt.slice(0, 80).toLowerCase().trim();
  if (needle) {
    for (const row of pages) {
      if (row.text.toLowerCase().includes(needle)) return row.page;
    }
  }
  for (const term of terms) {
    for (const row of pages) {
      if (row.text.toLowerCase().includes(term)) return row.page;
    }
  }
  return undefined;
}
