// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

export interface LawSnippetPage {
  page: number;
  text: string;
  /** True when the page text came from OCR rather than embedded PDF text. */
  ocr?: boolean;
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

/** One ready library file listed in every turn note so bots can see the shelf. */
export interface LawLibraryManifestEntry {
  id: string;
  filename: string;
  type: string;
  pageCount: number | null;
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
      const hit = pageForHit(doc.pages, excerpt, terms);
      let title = doc.title;
      if (hit !== undefined) {
        title = hit.ocr ? `${doc.title} (p. ${hit.page}) (OCR)` : `${doc.title} (p. ${hit.page})`;
      }
      return { title, excerpt };
    });
}

export function formatLawContext(input: {
  name: string;
  brief: string;
  snippets: readonly LawSnippet[];
  manifest?: readonly LawLibraryManifestEntry[];
  processingCount?: number;
}): string {
  const retrieved = input.snippets
    .map((snippet) => `### ${snippet.title}\n${snippet.excerpt}`)
    .join("\n\n");
  const manifest =
    input.manifest && input.manifest.length > 0
      ? `Case library:\n${input.manifest
          .map((entry) => {
            const pages =
              entry.pageCount != null && entry.pageCount > 0 ? `, ${entry.pageCount} pages` : "";
            return `- ${entry.filename} (${entry.type}${pages}) id=${entry.id}`;
          })
          .join("\n")}`
      : "";
  const processing =
    input.processingCount && input.processingCount > 0
      ? `${input.processingCount} file${input.processingCount === 1 ? "" : "s"} still processing`
      : "";
  return [
    `Case: ${input.name}`,
    `Brief:\n${input.brief}`,
    manifest,
    processing,
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
): { page: number; ocr: boolean } | undefined {
  if (!pages || pages.length === 0) return undefined;
  const needle = excerpt.slice(0, 80).toLowerCase().trim();
  if (needle) {
    for (const row of pages) {
      if (row.text.toLowerCase().includes(needle)) {
        return { page: row.page, ocr: Boolean(row.ocr) };
      }
    }
  }
  for (const term of terms) {
    for (const row of pages) {
      if (row.text.toLowerCase().includes(term)) {
        return { page: row.page, ocr: Boolean(row.ocr) };
      }
    }
  }
  return undefined;
}
