// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { t } from "@lingui/core/macro";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ListSearchInput,
} from "@rakazo/ui-web";
import { Captions, FileText, Film, Mic, X } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { useEffect, useRef } from "react";
import type { LawFileDoc } from "./files.js";
import { LAW_FOCUS } from "./library-rows.js";

export type LibrarySearchHit = {
  kind: "text" | "page" | "segment" | "frame";
  documentId: string;
  title: string;
  page?: number;
  startMs?: number;
  snippet: string;
  matches: Array<{ start: number; end: number }>;
  score: number;
};

export function formatHitClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Split a snippet and wrap match ranges without HTML injection. */
export function HighlightedSnippet({
  snippet,
  matches,
}: {
  snippet: string;
  matches: ReadonlyArray<{ start: number; end: number }>;
}) {
  if (!matches.length) return <>{snippet}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  const ordered = [...matches]
    .filter((m) => m.end > m.start && m.start >= 0 && m.end <= snippet.length)
    .sort((a, b) => a.start - b.start);
  for (const [index, match] of ordered.entries()) {
    if (match.start > cursor) {
      parts.push(<span key={`t-${index}-${cursor}`}>{snippet.slice(cursor, match.start)}</span>);
    }
    parts.push(
      <mark
        key={`m-${index}-${match.start}`}
        data-testid="law-search-mark"
        className="rounded-sm bg-warning/30 text-foreground"
      >
        {snippet.slice(match.start, match.end)}
      </mark>,
    );
    cursor = match.end;
  }
  if (cursor < snippet.length) {
    parts.push(<span key={`t-end-${cursor}`}>{snippet.slice(cursor)}</span>);
  }
  return <>{parts}</>;
}

function kindIcon(kind: LibrarySearchHit["kind"]) {
  const props = { size: 14, strokeWidth: 1.7, "aria-hidden": true as const };
  if (kind === "page") return <FileText {...props} />;
  if (kind === "segment") return <Mic {...props} />;
  if (kind === "frame") return <Film {...props} />;
  return <Captions {...props} />;
}

function hitMeta(hit: LibrarySearchHit): string | null {
  if (hit.kind === "page" && hit.page !== undefined) return t`p. ${hit.page}`;
  if (
    (hit.kind === "segment" || hit.kind === "frame") &&
    hit.startMs !== undefined &&
    Number.isFinite(hit.startMs)
  ) {
    return formatHitClock(hit.startMs);
  }
  return null;
}

export function LibrarySearchBox({
  query,
  setQuery,
  inputRef,
  onClear,
}: {
  query: string;
  setQuery: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  onClear: () => void;
}) {
  return (
    <div className="mt-2 flex items-center gap-1" data-testid="law-library-search">
      <div className="min-w-0 flex-1">
        <ListSearchInput
          query={query}
          setQuery={setQuery}
          label={t`Search library`}
          placeholder={t`Search`}
          inputRef={inputRef}
        />
      </div>
      {query ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={`size-7 shrink-0 text-muted-foreground ${LAW_FOCUS}`}
          aria-label={t`Clear search`}
          data-testid="law-library-search-clear"
          onClick={onClear}
        >
          <X size={14} strokeWidth={1.8} aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

export function LibrarySearchResults({
  hits,
  activeIndex,
  truncated,
  onActivate,
  onHover,
  listRef,
}: {
  hits: readonly LibrarySearchHit[];
  activeIndex: number;
  truncated: boolean;
  onActivate: (hit: LibrarySearchHit) => void;
  onHover: (index: number) => void;
  listRef?: RefObject<HTMLUListElement | null>;
}) {
  return (
    <div className="mt-2 flex min-h-0 flex-1 flex-col" data-testid="law-library-search-results">
      {truncated ? (
        <p
          className="mb-1 text-label text-muted-foreground"
          data-testid="law-library-search-truncated"
        >
          {t`Results may be incomplete`}
        </p>
      ) : null}
      {hits.length === 0 ? (
        <p className="px-1.5 py-2 text-body-sm text-muted-foreground">{t`No results`}</p>
      ) : (
        <ul
          ref={listRef}
          aria-label={t`Search results`}
          className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden"
        >
          {hits.map((hit, index) => {
            const meta = hitMeta(hit);
            const active = index === activeIndex;
            return (
              <li key={`${hit.kind}-${hit.documentId}-${hit.page ?? hit.startMs ?? index}`}>
                <button
                  type="button"
                  aria-current={active ? "true" : undefined}
                  data-testid={`law-search-hit-${index}`}
                  data-active={active ? "true" : undefined}
                  className={`flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-start ${LAW_FOCUS} ${
                    active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent"
                  }`}
                  onMouseEnter={() => onHover(index)}
                  onClick={() => onActivate(hit)}
                >
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center text-muted-foreground">
                    {kindIcon(hit.kind)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="truncate text-body-sm text-foreground">{hit.title}</span>
                      {meta ? (
                        <span className="shrink-0 text-label text-muted-foreground">{meta}</span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-label text-muted-foreground">
                      <HighlightedSnippet snippet={hit.snippet} matches={hit.matches} />
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Text viewer used for search hits so the first match can be marked and scrolled into view. */
export function SearchHitTextViewer({
  doc,
  snippet,
  matches,
  onClose,
}: {
  doc: LawFileDoc;
  snippet: string;
  matches: ReadonlyArray<{ start: number; end: number }>;
  onClose: () => void;
}) {
  const markRef = useRef<HTMLElement>(null);
  useEffect(() => {
    markRef.current?.scrollIntoView({ block: "center" });
  }, [doc.id, snippet]);

  const body = doc.body || "";
  const first = matches[0];
  // Prefer locating the snippet in the full body; fall back to showing the snippet alone.
  const at = first ? body.indexOf(snippet) : -1;
  let content: ReactNode;
  if (at >= 0 && first) {
    const absStart = at + first.start;
    const absEnd = at + first.end;
    content = (
      <>
        {body.slice(0, absStart)}
        <mark
          ref={markRef}
          data-testid="law-search-body-mark"
          className="rounded-sm bg-warning/30 text-foreground"
        >
          {body.slice(absStart, absEnd)}
        </mark>
        {body.slice(absEnd)}
      </>
    );
  } else {
    content = (
      <>
        <HighlightedSnippet snippet={snippet} matches={matches} />
        {body && body !== snippet ? (
          <span className="mt-4 block whitespace-pre-wrap text-muted-foreground">{body}</span>
        ) : null}
      </>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid="law-search-text-viewer"
        aria-label={doc.title}
        className="flex h-[min(860px,92vh)] w-[min(880px,96vw)] max-w-[min(880px,96vw)] flex-col gap-0 overflow-hidden rounded-lg border border-border bg-background p-0 shadow-lg sm:max-w-[min(880px,96vw)]"
      >
        <DialogHeader className="flex flex-row items-center gap-3 space-y-0 border-b border-border px-4 py-3 text-start">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-body font-medium text-foreground">
              {doc.title}
            </DialogTitle>
            <DialogDescription className="truncate text-label text-muted-foreground">
              {doc.filename}
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t`Close`}
            onClick={onClose}
            data-testid="law-search-text-close"
          >
            <X size={16} strokeWidth={1.8} aria-hidden="true" />
          </Button>
        </DialogHeader>
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-6 py-4 text-body text-foreground">
          {content}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

export function searchResultsKeyHandler(
  event: ReactKeyboardEvent | KeyboardEvent,
  options: {
    hitCount: number;
    activeIndex: number;
    setActiveIndex: (index: number) => void;
    onEnter: () => void;
    onEscape: () => void;
  },
): boolean {
  if (event.key === "Escape") {
    event.preventDefault();
    options.onEscape();
    return true;
  }
  if (options.hitCount === 0) return false;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    options.setActiveIndex(Math.min(options.hitCount - 1, options.activeIndex + 1));
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    options.setActiveIndex(Math.max(0, options.activeIndex - 1));
    return true;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    options.onEnter();
    return true;
  }
  return false;
}
