// @vitest-environment jsdom

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LawFileDoc } from "./files.js";
import { LawDocumentEditor, LawFileCard, LawFileViewer } from "./files.js";

const DOC: LawFileDoc = {
  id: "memo-1",
  title: "Fake Memo",
  filename: "fake-memo.md",
  kind: "review",
  body: "Original body",
  version: 1,
  rootId: "memo-1",
};

function CardHost({ onOpen }: { onOpen: (doc: LawFileDoc) => void }) {
  return createElement("ul", null, createElement(LawFileCard, { doc: DOC, onOpen }));
}

function ViewerHost({ onClose }: { onClose: () => void }) {
  return createElement(LawFileViewer, { doc: DOC, onClose });
}

function EditorHost({
  onClose,
  onSave = async () => {},
}: {
  onClose: () => void;
  onSave?: (body: string) => Promise<void>;
}) {
  return createElement(LawDocumentEditor, { doc: DOC, onClose, onSave });
}

function OpenFromCard() {
  const [open, setOpen] = useState(false);
  return createElement(
    "div",
    null,
    createElement(
      "ul",
      null,
      createElement(LawFileCard, { doc: DOC, onOpen: () => setOpen(true) }),
    ),
    open ? createElement(LawFileViewer, { doc: DOC, onClose: () => setOpen(false) }) : null,
  );
}

describe("law file primitives", () => {
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
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("opens a card with keyboard Enter and closes the dialog on Escape", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(OpenFromCard));
    });
    const openButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="law-file-card-memo-1"] button[aria-label="Fake Memo"]',
    );
    expect(openButton).not.toBeNull();
    openButton!.focus();
    await act(async () => {
      openButton!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      openButton!.click();
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="law-file-overlay"]')).not.toBeNull();
    });
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="law-file-overlay"]')).toBeNull();
    });
    expect(document.activeElement).toBe(openButton);
    await act(async () => {
      root.unmount();
    });
  });

  it("asks before closing the editor when text is unsaved", async () => {
    const onClose = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(EditorHost, { onClose }));
    });
    const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="law-doc-editor"]');
    const save = document.querySelector<HTMLButtonElement>('[data-testid="law-editor-save"]');
    expect(editor).not.toBeNull();
    expect(save?.disabled).toBe(true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(editor!, "Changed body");
      editor!.dispatchEvent(new Event("input", { bubbles: true }));
      editor!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>('[data-testid="law-editor-save"]')?.disabled,
      ).toBe(false);
    });
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Discard changes?");
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="law-file-overlay"]')).not.toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  it("disables Save until the text changes", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ViewerHost, { onClose: () => {} }));
    });
    expect(document.querySelector('[data-testid="law-viewer-download"]')).not.toBeNull();
    await act(async () => {
      root.render(createElement(EditorHost, { onClose: () => {} }));
    });
    expect(
      document.querySelector<HTMLButtonElement>('[data-testid="law-editor-save"]')?.disabled,
    ).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });

  it("opens from a single click without requiring double-click", async () => {
    const onOpen = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CardHost, { onOpen }));
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="law-file-card-memo-1"] button[aria-label="Fake Memo"]',
        )
        ?.click();
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]?.[0]).toMatchObject({ id: "memo-1" });
    await act(async () => {
      root.unmount();
    });
  });
});
