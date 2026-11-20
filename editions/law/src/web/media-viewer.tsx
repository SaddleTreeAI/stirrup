// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { t } from "@lingui/core/macro";
import { Button, Input, Spinner } from "@rakazo/ui-web";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject, UIEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { LawFileDoc } from "./files.js";
import { fileExtension } from "./files.js";
import { withSpaceHeaders } from "./lib.js";
import { LAW_FOCUS } from "./library-rows.js";

const SEGMENTS_PAGE = 500;
const ROW_HEIGHT = 44;
const OVERSCAN = 8;
const TIMEUPDATE_THROTTLE_MS = 250;
const FOLLOW_RESUME_MS = 10_000;
const JUMP_SEC = 5;

export const MACHINE_TRANSCRIPT_BANNER =
  "Machine transcript. Not a certified transcript; check against the recording.";

export type TranscriptSegmentRow = {
  idx: number;
  startMs: number;
  endMs: number;
  speaker: string | null;
  text: string;
};

export type LawMediaViewerProps = {
  doc: LawFileDoc;
  caseId: string;
  spaceId: string | null;
  /** Seek to this time on open (paused). */
  startMs?: number;
};

function fileHref(caseId: string, docId: string): string {
  return `/api/law/cases/${caseId}/documents/${docId}/file`;
}

function transcriptHref(caseId: string, docId: string, format: "txt" | "srt" | "vtt"): string {
  return `/api/law/cases/${caseId}/documents/${docId}/transcript?format=${format}`;
}

export function isMediaLawDocument(doc: LawFileDoc): boolean {
  const mime = (doc.mimeType ?? "").toLowerCase();
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return true;
  const ext = fileExtension(doc.filename);
  return ["mp3", "mp4", "m4a", "wav", "webm", "ogg", "aac", "flac", "mov", "mkv", "opus"].includes(
    ext,
  );
}

export function isVideoLawDocument(doc: LawFileDoc): boolean {
  const mime = (doc.mimeType ?? "").toLowerCase();
  if (mime.startsWith("video/")) return true;
  if (mime.startsWith("audio/")) return false;
  const ext = fileExtension(doc.filename);
  return ["mp4", "webm", "mov", "mkv"].includes(ext);
}

/** Format milliseconds as hh:mm:ss for transcript row buttons. */
export function formatMediaClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Case- and diacritics-insensitive fold for transcript search. */
export function foldSearchText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function findSegmentIndexAt(
  segments: readonly TranscriptSegmentRow[],
  timeMs: number,
): number {
  if (segments.length === 0) return -1;
  let lo = 0;
  let hi = segments.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid]!;
    if (seg.startMs <= timeMs && timeMs < seg.endMs) return mid;
    if (seg.endMs <= timeMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best >= 0 && timeMs >= segments[best]!.startMs) return best;
  return segments[0]!.startMs <= timeMs ? 0 : -1;
}

/**
 * Native media player with a timestamp-linked, searchable transcript pane.
 * Media src is the same-origin file URL (cookie auth); no blob copy.
 */
export function LawMediaViewer({ doc, caseId, spaceId, startMs }: LawMediaViewerProps) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const followResumeTimer = useRef<number | null>(null);
  const lastTick = useRef(0);
  const followRef = useRef(true);

  const [segments, setSegments] = useState<TranscriptSegmentRow[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [currentMs, setCurrentMs] = useState(startMs ?? 0);
  const [followPlayback, setFollowPlayback] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);

  const video = isVideoLawDocument(doc);
  const mediaSrc = `${fileHref(caseId, doc.id)}?inline=1`;
  const status = doc.status ?? "ready";
  const pending = status === "queued" || status === "processing";
  const failed = status === "failed";
  const ready = !pending && !failed;

  followRef.current = followPlayback;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setSegments([]);
    setExhausted(false);
    setLoadError(false);
    setLoadingMore(true);

    void (async () => {
      try {
        const loaded: TranscriptSegmentRow[] = [];
        let fromMs = 0;
        for (;;) {
          const toMs = Number.MAX_SAFE_INTEGER;
          const response = await fetch(
            `/api/law/cases/${caseId}/documents/${doc.id}/segments?from=${fromMs}&to=${toMs}`,
            {
              credentials: "same-origin",
              headers: withSpaceHeaders(undefined, spaceId),
              signal: controller.signal,
            },
          );
          if (!response.ok) throw new Error(String(response.status));
          const body = (await response.json()) as { segments: TranscriptSegmentRow[] };
          if (cancelled) return;
          const page = body.segments ?? [];
          if (page.length === 0) {
            setExhausted(true);
            break;
          }
          const seen = new Set(loaded.map((row) => row.idx));
          const fresh = page.filter((row) => !seen.has(row.idx));
          if (fresh.length === 0) {
            setExhausted(true);
            break;
          }
          loaded.push(...fresh);
          setSegments([...loaded]);
          if (page.length < SEGMENTS_PAGE) {
            setExhausted(true);
            break;
          }
          const last = page[page.length - 1]!;
          fromMs = last.endMs + 1;
        }
      } catch {
        if (!cancelled && !controller.signal.aborted) setLoadError(true);
      } finally {
        if (!cancelled) setLoadingMore(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [caseId, doc.id, spaceId]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media || startMs === undefined || !Number.isFinite(startMs) || startMs < 0) return;
    const apply = () => {
      media.currentTime = startMs / 1000;
      media.pause();
      setCurrentMs(startMs);
    };
    if (media.readyState >= 1) apply();
    else media.addEventListener("loadedmetadata", apply, { once: true });
  }, [startMs, doc.id]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => setViewportHeight(list.clientHeight || 480);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (followResumeTimer.current !== null) window.clearTimeout(followResumeTimer.current);
    };
  }, []);

  const foldedQuery = foldSearchText(searchQuery.trim());
  const matchIndexes =
    foldedQuery.length === 0
      ? []
      : segments.reduce<number[]>((acc, seg, index) => {
          if (foldSearchText(seg.text).includes(foldedQuery)) acc.push(index);
          return acc;
        }, []);
  const matchCount = matchIndexes.length;
  const activeMatchPos = matchCount === 0 ? 0 : Math.min(matchIndex, matchCount - 1);
  const activeMatchSeg = matchCount > 0 ? matchIndexes[activeMatchPos]! : -1;
  const activeSeg = findSegmentIndexAt(segments, currentMs);

  useEffect(() => {
    if (!followPlayback || activeSeg < 0) return;
    const list = listRef.current;
    if (!list) return;
    const top = activeSeg * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
      const nextTop = Math.max(0, top - list.clientHeight / 3);
      if (typeof list.scrollTo === "function") list.scrollTo({ top: nextTop, behavior: "auto" });
      else list.scrollTop = nextTop;
    }
  }, [activeSeg, followPlayback, currentMs]);

  function pauseFollowFromScroll() {
    if (!followRef.current) return;
    setFollowPlayback(false);
    if (followResumeTimer.current !== null) window.clearTimeout(followResumeTimer.current);
    followResumeTimer.current = window.setTimeout(() => {
      setFollowPlayback(true);
      followResumeTimer.current = null;
    }, FOLLOW_RESUME_MS);
  }

  function onTimeUpdate() {
    const now = performance.now();
    if (now - lastTick.current < TIMEUPDATE_THROTTLE_MS) return;
    lastTick.current = now;
    const media = mediaRef.current;
    if (!media) return;
    setCurrentMs(Math.round(media.currentTime * 1000));
  }

  function seekTo(ms: number) {
    const media = mediaRef.current;
    if (!media) return;
    media.currentTime = Math.max(0, ms / 1000);
    void media.play().catch(() => undefined);
    setCurrentMs(Math.max(0, ms));
  }

  function jumpBy(seconds: number) {
    const media = mediaRef.current;
    if (!media) return;
    const next = Math.max(0, media.currentTime + seconds);
    media.currentTime = next;
    setCurrentMs(Math.round(next * 1000));
  }

  function togglePlay() {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) void media.play().catch(() => undefined);
    else media.pause();
  }

  function onPaneKeyDown(event: ReactKeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea")) return;
    if (event.key === " ") {
      event.preventDefault();
      togglePlay();
      return;
    }
    if (event.key === "[") {
      event.preventDefault();
      jumpBy(-JUMP_SEC);
      return;
    }
    if (event.key === "]") {
      event.preventDefault();
      jumpBy(JUMP_SEC);
    }
  }

  function goMatch(delta: number) {
    if (matchCount === 0) return;
    const next = (activeMatchPos + delta + matchCount) % matchCount;
    setMatchIndex(next);
    const segIndex = matchIndexes[next]!;
    const list = listRef.current;
    if (!list) return;
    const nextTop = segIndex * ROW_HEIGHT;
    if (typeof list.scrollTo === "function") list.scrollTo({ top: nextTop, behavior: "auto" });
    else list.scrollTop = nextTop;
  }

  async function copySelectionWithTimestamps() {
    const selection =
      typeof window !== "undefined" ? (window.getSelection()?.toString() ?? "") : "";
    const foldedSelection = foldSearchText(selection.trim());
    let lines: string[];
    if (foldedSelection) {
      lines = segments
        .filter(
          (seg) =>
            foldSearchText(seg.text).includes(foldedSelection) ||
            foldedSelection.includes(foldSearchText(seg.text)),
        )
        .map((seg) => `[${formatMediaClock(seg.startMs)}] ${seg.text}`);
      if (lines.length === 0) {
        lines = segments
          .filter((seg) => selection.includes(seg.text) || seg.text.includes(selection.trim()))
          .map((seg) => `[${formatMediaClock(seg.startMs)}] ${seg.text}`);
      }
    } else if (activeSeg >= 0) {
      const seg = segments[activeSeg]!;
      lines = [`[${formatMediaClock(seg.startMs)}] ${seg.text}`];
    } else {
      lines = [];
    }
    if (lines.length === 0) return;
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
    } catch {
      // Clipboard may be denied; control still present.
    }
  }

  function downloadTranscript(format: "txt" | "srt" | "vtt") {
    const anchor = document.createElement("a");
    anchor.href = transcriptHref(caseId, doc.id, format);
    anchor.download = "";
    anchor.rel = "noopener";
    anchor.click();
  }

  const totalHeight = segments.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(segments.length, startIndex + visibleCount);
  const visible = segments.slice(startIndex, endIndex);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0 md:flex-row" data-testid="law-media-viewer">
      <div className="flex min-h-0 flex-1 flex-col border-b border-border md:border-b-0 md:border-r">
        {video ? (
          // biome-ignore lint/a11y/useMediaCaption: transcript pane is the caption surface
          <video
            ref={mediaRef as RefObject<HTMLVideoElement>}
            controls
            preload="metadata"
            src={mediaSrc}
            data-testid="law-media-element"
            className="max-h-[40vh] w-full bg-background object-contain md:max-h-none md:flex-1"
            onTimeUpdate={onTimeUpdate}
            onKeyDown={onPaneKeyDown}
          />
        ) : (
          // biome-ignore lint/a11y/useMediaCaption: transcript pane is the caption surface
          <audio
            ref={mediaRef as RefObject<HTMLAudioElement>}
            controls
            preload="metadata"
            src={mediaSrc}
            data-testid="law-media-element"
            className="w-full px-4 py-6"
            onTimeUpdate={onTimeUpdate}
            onKeyDown={onPaneKeyDown}
          />
        )}
      </div>

      <div
        ref={paneRef}
        role="application"
        aria-label={t`Transcript`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: pane must be focusable for Space/[ /] shortcuts
        tabIndex={0}
        data-testid="law-media-transcript-pane"
        className={`flex min-h-0 w-full flex-1 flex-col outline-none md:max-w-[min(420px,46%)] ${LAW_FOCUS}`}
        onKeyDown={onPaneKeyDown}
      >
        <p
          data-testid="law-media-banner"
          className="shrink-0 border-b border-border bg-muted/40 px-4 py-2 text-label text-muted-foreground"
        >
          {t`Machine transcript. Not a certified transcript; check against the recording.`}
        </p>

        {pending ? (
          <div
            data-testid="law-media-status-pending"
            className="flex items-center gap-2 border-b border-border px-4 py-3 text-body-sm text-muted-foreground"
          >
            <Spinner className="size-4" />
            <span>{doc.statusDetail || t`Waiting to transcribe`}</span>
          </div>
        ) : null}
        {failed ? (
          <p
            data-testid="law-media-status-failed"
            className="border-b border-border px-4 py-3 text-body-sm text-destructive"
          >
            {doc.statusDetail || t`Couldn't transcribe`}
          </p>
        ) : null}

        {ready ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <label className="sr-only" htmlFor="law-media-search">
              {t`Search transcript`}
            </label>
            <Input
              ref={searchInputRef}
              id="law-media-search"
              data-testid="law-media-search"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setMatchIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  goMatch(event.shiftKey ? -1 : 1);
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  goMatch(1);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  goMatch(-1);
                }
              }}
              placeholder={t`Search transcript`}
              className="h-8 min-w-[10rem] flex-1"
            />
            <span data-testid="law-media-search-count" className="text-label text-muted-foreground">
              {foldedQuery
                ? matchCount === 0
                  ? t`0 of 0`
                  : t`${activeMatchPos + 1} of ${matchCount}`
                : null}
            </span>
            <Button
              type="button"
              size="sm"
              variant={followPlayback ? "secondary" : "ghost"}
              aria-pressed={followPlayback}
              data-testid="law-media-follow"
              onClick={() => {
                if (followResumeTimer.current !== null) {
                  window.clearTimeout(followResumeTimer.current);
                  followResumeTimer.current = null;
                }
                setFollowPlayback((value) => !value);
              }}
            >
              {t`Follow playback`}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="law-media-copy"
              onClick={() => void copySelectionWithTimestamps()}
            >
              {t`Copy selection with timestamps`}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="law-media-download-txt"
              onClick={() => downloadTranscript("txt")}
            >
              {t`Download txt`}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="law-media-download-srt"
              onClick={() => downloadTranscript("srt")}
            >
              {t`Download srt`}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="law-media-download-vtt"
              onClick={() => downloadTranscript("vtt")}
            >
              {t`Download vtt`}
            </Button>
          </div>
        ) : null}

        <ul
          ref={listRef}
          data-testid="law-media-transcript-list"
          className="min-h-0 flex-1 list-none overflow-y-auto p-0"
          onScroll={(event: UIEvent<HTMLUListElement>) => {
            setScrollTop(event.currentTarget.scrollTop);
            pauseFollowFromScroll();
          }}
        >
          {loadError ? (
            <li className="px-4 py-6 text-body-sm text-destructive">{t`Couldn't load transcript`}</li>
          ) : null}
          {!loadError && ready && segments.length === 0 && !loadingMore ? (
            <li className="px-4 py-6 text-body-sm text-muted-foreground">{t`No transcript yet`}</li>
          ) : null}
          <li
            aria-hidden="true"
            style={{ height: totalHeight, position: "relative", listStyle: "none" }}
          >
            <ul className="absolute inset-0 list-none p-0">
              {visible.map((seg, offset) => {
                const index = startIndex + offset;
                const isActive = index === activeSeg;
                const isMatch = index === activeMatchSeg;
                return (
                  <li
                    key={seg.idx}
                    data-testid={`law-media-segment-${seg.idx}`}
                    data-active={isActive ? "true" : "false"}
                    className={`absolute flex w-full items-start gap-2 border-l-2 px-3 py-1.5 ${
                      isActive
                        ? "border-l-foreground bg-muted/40"
                        : isMatch
                          ? "border-l-foreground/50 bg-muted/20"
                          : "border-l-transparent"
                    }`}
                    style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                  >
                    <button
                      type="button"
                      className={`shrink-0 rounded-sm px-1 font-mono text-label text-muted-foreground hover:text-foreground ${LAW_FOCUS}`}
                      data-testid={`law-media-seek-${seg.idx}`}
                      onClick={() => seekTo(seg.startMs)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          seekTo(seg.startMs);
                        }
                      }}
                    >
                      {formatMediaClock(seg.startMs)}
                    </button>
                    {seg.speaker ? (
                      <span
                        data-testid={`law-media-speaker-${seg.idx}`}
                        className="shrink-0 rounded border border-border px-1.5 py-0.5 text-label text-foreground"
                      >
                        {seg.speaker}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className={`min-w-0 flex-1 truncate rounded-sm text-start text-body-sm text-foreground ${LAW_FOCUS}`}
                      onClick={() => seekTo(seg.startMs)}
                    >
                      {foldedQuery ? (
                        <HighlightedText text={seg.text} query={foldedQuery} />
                      ) : (
                        seg.text
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
          {loadingMore ? (
            <li className="flex items-center gap-2 px-4 py-3 text-label text-muted-foreground">
              <Spinner className="size-4" />
              {t`Loading transcript…`}
            </li>
          ) : null}
          {exhausted && segments.length > 0 ? (
            <li className="sr-only" data-testid="law-media-segments-exhausted">
              done
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const folded = foldSearchText(text);
  const at = folded.indexOf(query);
  if (at < 0 || query.length === 0) return <>{text}</>;
  // Map folded index back approximately by walking original characters.
  let foldedPos = 0;
  let start = 0;
  let end = text.length;
  for (let i = 0; i < text.length; i += 1) {
    const ch = foldSearchText(text[i]!);
    if (ch.length === 0) continue;
    if (foldedPos === at) start = i;
    foldedPos += ch.length;
    if (foldedPos === at + query.length) {
      end = i + 1;
      break;
    }
  }
  return (
    <>
      {text.slice(0, start)}
      <mark data-testid="law-media-search-hit" className="bg-muted text-foreground">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}
