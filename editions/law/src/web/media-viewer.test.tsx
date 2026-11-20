// @vitest-environment jsdom

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LawFileDoc } from "./files.js";
import {
  findSegmentIndexAt,
  foldSearchText,
  formatMediaClock,
  LawMediaViewer,
  MACHINE_TRANSCRIPT_BANNER,
} from "./media-viewer.js";

const DOC: LawFileDoc = {
  id: "media-1",
  title: "Hearing clip",
  filename: "hearing.mp4",
  kind: "upload",
  body: "",
  version: 1,
  rootId: "media-1",
  source: "upload",
  mimeType: "video/mp4",
  hasOriginal: true,
  status: "ready",
  statusDetail: MACHINE_TRANSCRIPT_BANNER,
  durationMs: 12_000,
};

const SEGMENTS = [
  { idx: 0, startMs: 0, endMs: 2000, speaker: "A", text: "Alpha one" },
  { idx: 1, startMs: 2000, endMs: 4000, speaker: null, text: "Beta two" },
  { idx: 2, startMs: 4000, endMs: 6000, speaker: "B", text: "Gamma café" },
  { idx: 3, startMs: 6000, endMs: 8000, speaker: null, text: "Delta four" },
];

function stubMediaElement() {
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn(async () => undefined),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "load", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "paused", {
    configurable: true,
    get() {
      return (this as { _paused?: boolean })._paused !== false;
    },
  });
  let currentTime = 0;
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    configurable: true,
    get() {
      return currentTime;
    },
    set(value: number) {
      currentTime = value;
      (this as { _paused?: boolean })._paused = (this as { _paused?: boolean })._paused;
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
    configurable: true,
    get() {
      return 4;
    },
  });
}

describe("media viewer helpers", () => {
  it("formats clocks and folds diacritics for search", () => {
    expect(formatMediaClock(75_000)).toBe("00:01:15");
    expect(foldSearchText("Café")).toBe("cafe");
    expect(findSegmentIndexAt(SEGMENTS, 2500)).toBe(1);
  });
});

describe("LawMediaViewer", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    stubMediaElement();
    if (typeof Element !== "undefined" && !Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
      Element.prototype.setPointerCapture = () => {};
      Element.prototype.releasePointerCapture = () => {};
    }
    if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = () => {};
    }
    if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.scrollTo) {
      HTMLElement.prototype.scrollTo = () => {};
    }
    class FakeResizeObserver {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mountViewer(
    doc: LawFileDoc = DOC,
    options: { startMs?: number; segmentsPages?: unknown[][] } = {},
  ) {
    const pages = options.segmentsPages ?? [SEGMENTS];
    let pageIndex = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/segments?")) {
        const page = pages[pageIndex] ?? [];
        pageIndex += 1;
        return new Response(JSON.stringify({ segments: page, limit: 500 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(LawMediaViewer, {
          doc,
          caseId: "case-1",
          spaceId: "space-1",
          startMs: options.startMs,
        }),
      );
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="law-media-viewer"]')).not.toBeNull();
    });
    return { container, root, fetchMock };
  }

  it("shows the machine transcript banner and seeks on click", async () => {
    const { root, fetchMock } = await mountViewer();
    expect(document.querySelector('[data-testid="law-media-banner"]')?.textContent).toBe(
      MACHINE_TRANSCRIPT_BANNER,
    );
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="law-media-segment-0"]')).not.toBeNull();
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("from=0"))).toBe(true);

    const media = document.querySelector<HTMLMediaElement>('[data-testid="law-media-element"]');
    expect(media?.getAttribute("src")).toContain("/file?inline=1");
    expect(media?.getAttribute("preload")).toBe("metadata");

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="law-media-seek-1"]')?.click();
    });
    expect(media?.currentTime).toBe(2);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("highlights the active row from timeupdate without stealing focus", async () => {
    const { root } = await mountViewer();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="law-media-segment-0"]')).not.toBeNull();
    });
    const media = document.querySelector<HTMLMediaElement>('[data-testid="law-media-element"]')!;
    const search = document.querySelector<HTMLInputElement>('[data-testid="law-media-search"]')!;
    search.focus();
    expect(document.activeElement).toBe(search);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")!.set!.call(
        media,
        4.2,
      );
      media.dispatchEvent(new Event("timeupdate"));
      await new Promise((resolve) => setTimeout(resolve, 260));
      media.dispatchEvent(new Event("timeupdate"));
    });
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-testid="law-media-segment-2"]')?.getAttribute("data-active"),
      ).toBe("true");
    });
    expect(document.activeElement).toBe(search);

    await act(async () => {
      root.unmount();
    });
  });

  it("updates search count, highlights matches, and navigates with Enter", async () => {
    expect(foldSearchText("café")).toBe(foldSearchText("cafe"));
    const { root } = await mountViewer();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="law-media-search"]')).not.toBeNull();
    });

    const search = document.querySelector<HTMLInputElement>('[data-testid="law-media-search"]')!;
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      nativeInputValueSetter?.call(search, "cafe");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="law-media-search-count"]')?.textContent).toBe(
        "1 of 1",
      );
    });
    expect(document.querySelector('[data-testid="law-media-search-hit"]')).not.toBeNull();

    await act(async () => {
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("toggles follow playback off and pauses follow after manual scroll", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const { root } = await mountViewer();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="law-media-transcript-list"]')).not.toBeNull();
    });

    const follow = document.querySelector<HTMLButtonElement>('[data-testid="law-media-follow"]');
    expect(follow).not.toBeNull();
    expect(follow?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      follow?.click();
    });
    expect(follow?.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      follow?.click();
    });
    expect(follow?.getAttribute("aria-pressed")).toBe("true");

    const list = document.querySelector<HTMLElement>('[data-testid="law-media-transcript-list"]')!;
    await act(async () => {
      Object.defineProperty(list, "scrollTop", { value: 80, configurable: true });
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 10_000)).toBe(true);

    await act(async () => {
      root.unmount();
    });
    setTimeoutSpy.mockRestore();
  });

  it("loads segments in windows with from/to query params", async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => ({
      idx: i,
      startMs: i * 1000,
      endMs: i * 1000 + 900,
      speaker: null,
      text: `line ${i}`,
    }));
    const page2 = [
      {
        idx: 500,
        startMs: 500_000,
        endMs: 500_900,
        speaker: null,
        text: "tail",
      },
    ];
    const { root, fetchMock } = await mountViewer(DOC, { segmentsPages: [page1, page2] });
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => /segments\?from=0&to=/.test(url))).toBe(true);
    // First page ends at idx 499 → endMs 499900; next window starts at endMs+1.
    expect(urls.some((url) => /segments\?from=499901&to=/.test(url))).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });

  it("shows pending spinner and failed status detail", async () => {
    const pending: LawFileDoc = {
      ...DOC,
      status: "processing",
      statusDetail: "Transcribing…",
    };
    const { root } = await mountViewer(pending, { segmentsPages: [[]] });
    expect(
      document.querySelector('[data-testid="law-media-status-pending"]')?.textContent,
    ).toContain("Transcribing…");
    await act(async () => {
      root.unmount();
    });

    const failed: LawFileDoc = {
      ...DOC,
      status: "failed",
      statusDetail: "Couldn't transcribe",
    };
    const second = await mountViewer(failed, { segmentsPages: [[]] });
    expect(
      document.querySelector('[data-testid="law-media-status-failed"]')?.textContent,
    ).toContain("Couldn't transcribe");
    await act(async () => {
      second.root.unmount();
    });
  });

  it("handles keyboard shortcuts on the pane but not inside the search input", async () => {
    const { root } = await mountViewer();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="law-media-element"]')).not.toBeNull();
    });
    const media = document.querySelector<HTMLMediaElement>('[data-testid="law-media-element"]')!;
    const pane = document.querySelector<HTMLElement>('[data-testid="law-media-transcript-pane"]')!;
    const search = document.querySelector<HTMLInputElement>('[data-testid="law-media-search"]')!;

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")!.set!.call(
        media,
        10,
      );
      pane.focus();
      pane.dispatchEvent(
        new KeyboardEvent("keydown", { key: "[", bubbles: true, cancelable: true }),
      );
    });
    expect(media.currentTime).toBe(5);

    await act(async () => {
      pane.dispatchEvent(
        new KeyboardEvent("keydown", { key: "]", bubbles: true, cancelable: true }),
      );
    });
    expect(media.currentTime).toBe(10);

    const playMock = HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>;
    playMock.mockClear();
    await act(async () => {
      pane.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
      );
    });
    expect(playMock).toHaveBeenCalled();

    playMock.mockClear();
    const before = media.currentTime;
    await act(async () => {
      search.focus();
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "[", bubbles: true, cancelable: true }),
      );
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
      );
    });
    expect(media.currentTime).toBe(before);
    expect(playMock).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("opens paused at startMs from a deep link", async () => {
    const { root } = await mountViewer(DOC, { startMs: 3500 });
    await vi.waitFor(() => {
      const media = document.querySelector<HTMLMediaElement>('[data-testid="law-media-element"]');
      expect(media?.currentTime).toBe(3.5);
    });
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });
});
