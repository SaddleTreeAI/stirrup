// @vitest-environment jsdom

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LawFileDoc } from "./files.js";
import { LawPdfViewer } from "./pdf-viewer.js";

const DOC: LawFileDoc = {
  id: "pdf-1",
  title: "Synthetic Brief",
  filename: "brief.pdf",
  kind: "upload",
  body: "",
  version: 1,
  rootId: "pdf-1",
  mimeType: "application/pdf",
  hasOriginal: true,
  pageCount: 3,
  status: "ready",
};

describe("LawPdfViewer", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    if (typeof Element !== "undefined" && !Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
      Element.prototype.setPointerCapture = () => {};
      Element.prototype.releasePointerCapture = () => {};
    }
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("loads a blob URL with #page= in the iframe src and revokes on unmount", async () => {
    const revoke = vi.fn();
    const create = vi.fn(() => "blob:mock-pdf");
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/file?inline=1")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
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
        createElement(LawPdfViewer, {
          doc: DOC,
          caseId: "case-1",
          spaceId: "space-1",
          page: 3,
        }),
      );
    });
    await vi.waitFor(() => {
      const iframe = container.querySelector<HTMLIFrameElement>('[data-testid="law-pdf-iframe"]');
      expect(iframe).not.toBeNull();
      expect(iframe?.src).toContain("#page=3");
      expect(iframe?.title).toBe("Synthetic Brief");
    });
    expect(create).toHaveBeenCalled();

    await act(async () => {
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="law-pdf-page-input"]',
      )!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      container.querySelector<HTMLElement>('[data-testid="law-pdf-go"]')?.click();
    });
    await vi.waitFor(() => {
      const iframe = container.querySelector<HTMLIFrameElement>('[data-testid="law-pdf-iframe"]');
      expect(iframe?.src).toContain("#page=2");
    });

    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="law-pdf-copy-citation"]')?.click();
    });
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("Synthetic Brief, p. 2");
    });

    await act(async () => {
      root.unmount();
    });
    expect(revoke).toHaveBeenCalledWith("blob:mock-pdf");
  });
});
