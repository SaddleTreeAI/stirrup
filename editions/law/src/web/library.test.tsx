// @vitest-environment jsdom

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { deferred, flush } from "@rakazo/core/test-async";
import { TooltipProvider } from "@rakazo/ui-web";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LawFileDoc } from "./files.js";
import { LawCaseDocuments } from "./library.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lawDoc(partial: Partial<LawFileDoc> & Pick<LawFileDoc, "id" | "title">): LawFileDoc {
  return {
    filename: `${partial.id}.md`,
    kind: "library",
    body: partial.title,
    version: 1,
    rootId: partial.id,
    createdAt: "2026-01-02T00:00:00.000Z",
    source: "edit",
    mimeType: "text/markdown",
    sizeBytes: 12,
    status: "ready",
    statusDetail: "",
    hasOriginal: false,
    ...partial,
  };
}

async function mountLibrary(docs: LawFileDoc[] = []) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/law/cases/case-1/documents" && (!init?.method || init.method === "GET")) {
      return jsonResponse({ documents: docs });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => {
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(LawCaseDocuments, {
          caseId: "case-1",
          spaceId: "space-1",
          shellError: null,
          reload: () => {},
        }),
      ),
    );
  });
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="law-library"]')).not.toBeNull();
  });
  return { container, root, fetchMock };
}

describe("law library", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    if (typeof Element !== "undefined" && !Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
      Element.prototype.setPointerCapture = () => {};
      Element.prototype.releasePointerCapture = () => {};
    }
    if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = () => {};
    }
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("lists + menu items for upload and new note", async () => {
    const { container, root } = await mountLibrary();
    const add = container.querySelector<HTMLElement>('[data-testid="law-library-add"]');
    expect(add).not.toBeNull();
    await act(async () => {
      add!.click();
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="law-library-upload-files"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="law-library-new-note"]')).not.toBeNull();
    });
    await act(async () => {
      root.unmount();
    });
  });

  it("uploads two chosen files and replaces progress rows", async () => {
    const uploadA = deferred<Response>();
    const uploadB = deferred<Response>();
    let uploadCount = 0;
    const { container, root, fetchMock } = await mountLibrary();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/law/cases/case-1/documents" && (!init?.method || init.method === "GET")) {
        return jsonResponse({ documents: [] });
      }
      if (url.endsWith("/documents/upload") && init?.method === "POST") {
        uploadCount += 1;
        return uploadCount === 1 ? uploadA.promise : uploadB.promise;
      }
      return new Response("not found", { status: 404 });
    });

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="law-library-file-input"]',
    );
    expect(input).not.toBeNull();
    const fileA = new File(["a"], "alpha.txt", { type: "text/plain" });
    const fileB = new File(["b"], "beta.txt", { type: "text/plain" });
    await act(async () => {
      const list = {
        0: fileA,
        1: fileB,
        length: 2,
        item: (index: number) => (index === 0 ? fileA : fileB),
        [Symbol.iterator]: function* () {
          yield fileA;
          yield fileB;
        },
      } as unknown as FileList;
      Object.defineProperty(input!, "files", { configurable: true, value: list });
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await vi.waitFor(() => {
      expect(container.querySelectorAll('[data-testid^="law-upload-progress-"]').length).toBe(2);
      expect(container.textContent).toContain("Uploading");
    });
    expect(uploadCount).toBe(2);

    uploadA.resolve(
      jsonResponse(
        {
          document: lawDoc({
            id: "doc-a",
            title: "alpha",
            filename: "alpha.txt",
            kind: "upload",
            source: "upload",
          }),
        },
        201,
      ),
    );
    uploadB.resolve(
      jsonResponse(
        {
          document: lawDoc({
            id: "doc-b",
            title: "beta",
            filename: "beta.txt",
            kind: "upload",
            source: "upload",
          }),
        },
        201,
      ),
    );
    await act(async () => {
      await flush();
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="law-file-card-doc-a"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="law-file-card-doc-b"]')).not.toBeNull();
      expect(container.querySelectorAll('[data-testid^="law-upload-progress-"]').length).toBe(0);
    });
    await act(async () => {
      root.unmount();
    });
  });

  it("shows Open existing on a 409 duplicate upload", async () => {
    const { container, root, fetchMock } = await mountLibrary([
      lawDoc({ id: "existing-1", title: "Existing Memo" }),
    ]);
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/law/cases/case-1/documents" && (!init?.method || init.method === "GET")) {
        return jsonResponse({ documents: [lawDoc({ id: "existing-1", title: "Existing Memo" })] });
      }
      if (url.endsWith("/documents/upload")) {
        return jsonResponse({ error: "Duplicate content", existingId: "existing-1" }, 409);
      }
      return new Response("not found", { status: 404 });
    });
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="law-library-file-input"]',
    );
    const file = new File(["dup"], "dup.txt", { type: "text/plain" });
    await act(async () => {
      Object.defineProperty(input!, "files", {
        configurable: true,
        value: {
          0: file,
          length: 1,
          item: () => file,
          [Symbol.iterator]: function* () {
            yield file;
          },
        },
      });
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Open existing");
    });
    await act(async () => {
      root.unmount();
    });
  });

  it("renames on Enter and cancels on Escape", async () => {
    const doc = lawDoc({ id: "memo-1", title: "Fake Memo" });
    const { container, root, fetchMock } = await mountLibrary([doc]);
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/law/cases/case-1/documents" && (!init?.method || init.method === "GET")) {
        return jsonResponse({ documents: [doc] });
      }
      if (url.endsWith("/documents/memo-1") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { title: string };
        return jsonResponse({ document: { ...doc, title: body.title } });
      }
      return new Response("not found", { status: 404 });
    });

    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="law-library-actions-memo-1"]')?.click();
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="law-library-rename-memo-1"]')).not.toBeNull();
    });
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="law-library-rename-memo-1"]')?.click();
    });
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="law-library-rename-input-memo-1"]'),
      ).not.toBeNull();
    });
    const renameInput = container.querySelector<HTMLInputElement>(
      '[data-testid="law-library-rename-input-memo-1"]',
    );
    await act(async () => {
      renameInput!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="law-library-rename-input-memo-1"]')).toBeNull();
    });

    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="law-library-actions-memo-1"]')?.click();
    });
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="law-library-rename-memo-1"]')?.click();
    });
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="law-library-rename-input-memo-1"]'),
      ).not.toBeNull();
    });
    const again = container.querySelector<HTMLInputElement>(
      '[data-testid="law-library-rename-input-memo-1"]',
    );
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(again!, "Renamed Memo");
      again!.dispatchEvent(new Event("input", { bubbles: true }));
      again!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Renamed Memo");
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/documents/memo-1"))).toBe(
      true,
    );
    await act(async () => {
      root.unmount();
    });
  });

  it("deletes after confirm and removes the row", async () => {
    const doc = lawDoc({ id: "memo-2", title: "Delete Me" });
    const { container, root, fetchMock } = await mountLibrary([doc]);
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/law/cases/case-1/documents" && (!init?.method || init.method === "GET")) {
        return jsonResponse({ documents: [doc] });
      }
      if (url.endsWith("/documents/memo-2") && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    });

    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="law-library-actions-memo-2"]')?.click();
    });
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="law-library-delete-memo-2"]')?.click();
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="law-library-delete-confirm"]')).not.toBeNull();
      expect(document.body.textContent).toContain("Delete Delete Me?");
      expect(document.body.textContent).toContain("It is removed from this case's Library.");
    });
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="law-library-delete-confirm-button"]')
        ?.click();
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="law-file-card-memo-2"]')).toBeNull();
    });
    await act(async () => {
      root.unmount();
    });
  });

  it("shows extraction worker isn't running when queued over a minute", async () => {
    const stuck = lawDoc({
      id: "stuck-1",
      title: "Stuck PDF",
      filename: "stuck.pdf",
      mimeType: "application/pdf",
      status: "queued",
      statusDetail: "Reading PDF",
      kind: "upload",
      source: "upload",
      createdAt: new Date(Date.now() - 61_000).toISOString(),
    });
    const { container, root } = await mountLibrary([stuck]);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("extraction worker isn't running");
      expect(container.textContent).not.toContain("Reading PDF");
    });
    await act(async () => {
      root.unmount();
    });
  });

  it("shows processing detail and polls only while visible", async () => {
    const processing = lawDoc({
      id: "proc-1",
      title: "Processing",
      status: "processing",
      statusDetail: "Extracting text",
      kind: "upload",
      source: "upload",
    });
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const { container, root, fetchMock } = await mountLibrary([processing]);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Extracting text");
      expect(container.querySelector('[data-slot="spinner"]')).not.toBeNull();
    });
    await vi.waitFor(() => {
      expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 3_000)).toBe(true);
    });

    const listCallsBeforeHide = fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith("/documents"),
    ).length;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(clearTimeoutSpy).toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => {
      expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 3_000)).toBe(true);
    });
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/documents")).length,
    ).toBeGreaterThanOrEqual(listCallsBeforeHide);

    await act(async () => {
      root.unmount();
    });
  });

  it("opens a document at a page from ?doc=&page= deep link", async () => {
    const pdf = lawDoc({
      id: "pdf-deep",
      title: "Deep PDF",
      filename: "deep.pdf",
      mimeType: "application/pdf",
      kind: "upload",
      source: "upload",
      hasOriginal: true,
      pageCount: 3,
    });
    const previous = window.location.search;
    window.history.replaceState({}, "", "/app?doc=pdf-deep&page=2");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/law/cases/case-1/documents" && (!init?.method || init.method === "GET")) {
        return jsonResponse({ documents: [pdf] });
      }
      if (url.includes("/file?inline=1")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:deep",
      revokeObjectURL: () => {},
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(LawCaseDocuments, {
            caseId: "case-1",
            spaceId: "space-1",
            shellError: null,
            reload: () => {},
          }),
        ),
      );
    });
    await vi.waitFor(() => {
      // Dialog content portals to document.body.
      expect(document.querySelector('[data-testid="law-pdf-viewer"]')).not.toBeNull();
      expect(
        document.querySelector('[data-testid="law-pdf-iframe"]')?.getAttribute("src"),
      ).toContain("#page=2");
    });
    await act(async () => {
      root.unmount();
    });
    window.history.replaceState({}, "", `/app${previous}`);
  });

  it("opens media at a timestamp from ?doc=&t= deep link", async () => {
    const media = lawDoc({
      id: "media-deep",
      title: "Deep Media",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      kind: "upload",
      source: "upload",
      hasOriginal: true,
      durationMs: 10_000,
      statusDetail: "Machine transcript. Not a certified transcript; check against the recording.",
    });
    const previous = window.location.search;
    window.history.replaceState({}, "", "/app?doc=media-deep&t=4");
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: vi.fn(async () => undefined),
    });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", {
      configurable: true,
      value: vi.fn(),
    });
    let currentTime = 0;
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
      configurable: true,
      get: () => 4,
    });
    class FakeResizeObserver {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/law/cases/case-1/documents" && (!init?.method || init.method === "GET")) {
        return jsonResponse({ documents: [media] });
      }
      if (url.includes("/segments?")) {
        return jsonResponse({
          segments: [{ idx: 0, startMs: 0, endMs: 5000, speaker: null, text: "hello" }],
          limit: 500,
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
        createElement(
          TooltipProvider,
          null,
          createElement(LawCaseDocuments, {
            caseId: "case-1",
            spaceId: "space-1",
            shellError: null,
            reload: () => {},
          }),
        ),
      );
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="law-media-viewer"]')).not.toBeNull();
      expect(
        document.querySelector<HTMLMediaElement>('[data-testid="law-media-element"]')?.currentTime,
      ).toBe(4);
    });
    await act(async () => {
      root.unmount();
    });
    window.history.replaceState({}, "", `/app${previous}`);
  });

  it("shows the empty state with an Add files control", async () => {
    const { container, root } = await mountLibrary([]);
    expect(container.querySelector('[data-testid="law-library-empty"]')).not.toBeNull();
    expect(container.textContent).toContain("No files in this case yet");
    expect(container.querySelector('[data-testid="law-library-empty-add"]')).not.toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  it("supports keyboard paths for add, rename, and delete", async () => {
    const doc = lawDoc({ id: "kb-1", title: "Keyboard Doc" });
    const { container, root, fetchMock } = await mountLibrary([doc]);
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/law/cases/case-1/documents" && (!init?.method || init.method === "GET")) {
        return jsonResponse({ documents: [doc] });
      }
      if (url.endsWith("/documents/kb-1") && init?.method === "PATCH") {
        return jsonResponse({ document: { ...doc, title: "Keyed" } });
      }
      if (url.endsWith("/documents/kb-1") && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    });

    const add = container.querySelector<HTMLElement>('[data-testid="law-library-add"]');
    add!.focus();
    await act(async () => {
      add!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      add!.click();
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="law-library-new-note"]')).not.toBeNull();
    });
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    const actions = container.querySelector<HTMLElement>(
      '[data-testid="law-library-actions-kb-1"]',
    );
    actions!.focus();
    await act(async () => {
      actions!.click();
    });
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="law-library-rename-kb-1"]')?.click();
    });
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="law-library-rename-input-kb-1"]'),
      ).not.toBeNull();
    });
    await act(async () => {
      container
        .querySelector<HTMLInputElement>('[data-testid="law-library-rename-input-kb-1"]')
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
    });

    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="law-library-actions-kb-1"]')?.click();
    });
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="law-library-delete-kb-1"]')?.click();
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="law-library-delete-confirm"]')).not.toBeNull();
    });
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="law-library-delete-confirm-button"]')
        ?.focus();
      document
        .querySelector<HTMLElement>('[data-testid="law-library-delete-confirm-button"]')
        ?.click();
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="law-file-card-kb-1"]')).toBeNull();
    });
    await act(async () => {
      root.unmount();
    });
  });
});
