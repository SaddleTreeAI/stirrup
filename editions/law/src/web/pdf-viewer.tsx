// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { t } from "@lingui/core/macro";
import { Button, Input } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import type { LawFileDoc } from "./files.js";
import { withSpaceHeaders } from "./lib.js";

function fileHref(caseId: string, docId: string, variant?: "searchable"): string {
  const base = `/api/law/cases/${caseId}/documents/${docId}/file`;
  return variant === "searchable" ? `${base}?variant=searchable` : base;
}

export type LawPdfViewerProps = {
  doc: LawFileDoc;
  caseId: string;
  spaceId: string | null;
  page?: number;
  onClose?: () => void;
};

/**
 * Native iframe PDF viewer (same approach as core PdfViewer).
 * Page jumps use `#page=N` — Chromium and Firefox honor it; Safari only partly.
 * Citations use physical page numbers, not printed labels (e.g. "iii").
 */
export function LawPdfViewer({ doc, caseId, spaceId, page = 1 }: LawPdfViewerProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(Math.max(1, page));
  const [pageInput, setPageInput] = useState(String(Math.max(1, page)));
  const [showText, setShowText] = useState(false);
  const [pageText, setPageText] = useState<string | null>(null);
  const [pageOcr, setPageOcr] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const blobUrlRef = useRef<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCurrentPage(Math.max(1, page));
    setPageInput(String(Math.max(1, page)));
  }, [page, doc.id]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoadError(false);
    setBlobUrl(null);
    void (async () => {
      try {
        const response = await fetch(`${fileHref(caseId, doc.id)}?inline=1`, {
          credentials: "same-origin",
          headers: withSpaceHeaders(undefined, spaceId),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(String(response.status));
        const bytes = await response.arrayBuffer();
        if (cancelled) return;
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = url;
        setBlobUrl(url);
      } catch {
        if (!cancelled && !controller.signal.aborted) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [caseId, doc.id, spaceId]);

  useEffect(() => {
    if (!showText) {
      setPageText(null);
      setPageOcr(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/api/law/cases/${caseId}/documents/${doc.id}/pages?from=${currentPage}&to=${currentPage}`,
          {
            credentials: "same-origin",
            headers: withSpaceHeaders(undefined, spaceId),
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as {
          pages: Array<{ page: number; text: string; ocr?: boolean }>;
        };
        if (cancelled) return;
        setPageText(body.pages[0]?.text ?? "");
        setPageOcr(Boolean(body.pages[0]?.ocr));
      } catch {
        if (!cancelled && !controller.signal.aborted) {
          setPageText("");
          setPageOcr(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [showText, caseId, doc.id, spaceId, currentPage]);

  function goToPage(next: number) {
    const capped = Math.max(1, Math.floor(next) || 1);
    setCurrentPage(capped);
    setPageInput(String(capped));
  }

  async function copyCitation() {
    const text = `${doc.title}, p. ${currentPage}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Ignore clipboard failures; the control still exists for keyboard users.
    }
  }

  function downloadOriginal() {
    const anchor = document.createElement("a");
    anchor.href = fileHref(caseId, doc.id);
    anchor.download = doc.filename || doc.title;
    anchor.rel = "noopener";
    anchor.click();
  }

  function downloadSearchable() {
    const anchor = document.createElement("a");
    anchor.href = fileHref(caseId, doc.id, "searchable");
    anchor.download = `${(doc.filename || doc.title).replace(/\.[^.]+$/, "")}-searchable.pdf`;
    anchor.rel = "noopener";
    anchor.click();
  }

  const iframeSrc = blobUrl ? `${blobUrl}#page=${currentPage}&toolbar=1` : undefined;
  const showSearchable = Boolean(doc.hasSearchable);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="law-pdf-viewer">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <label
          className="flex items-center gap-1 text-label text-muted-foreground"
          htmlFor="law-pdf-page"
        >
          {t`Page`}
        </label>
        <Input
          ref={pageInputRef}
          id="law-pdf-page"
          data-testid="law-pdf-page-input"
          type="number"
          min={1}
          value={pageInput}
          onChange={(event) => setPageInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              goToPage(Number(pageInputRef.current?.value || pageInput));
            }
          }}
          className="h-7 w-16"
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="law-pdf-go"
          onClick={() => goToPage(Number(pageInputRef.current?.value || pageInput))}
        >
          {t`Go`}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="law-pdf-copy-citation"
          onClick={() => void copyCitation()}
        >
          {t`Copy citation`}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="law-pdf-download"
          onClick={downloadOriginal}
        >
          {t`Download original`}
        </Button>
        {showSearchable ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="law-pdf-download-searchable"
            onClick={downloadSearchable}
          >
            {t`Download searchable copy`}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant={showText ? "secondary" : "ghost"}
          data-testid="law-pdf-extracted-toggle"
          onClick={() => setShowText((value) => !value)}
        >
          {t`Extracted text`}
        </Button>
        <span className="text-label text-muted-foreground">
          {t`Page numbers are physical pages, not printed labels.`}
        </span>
      </div>
      {loadError ? (
        <p className="px-6 py-10 text-center text-body-sm text-destructive">{t`Couldn't open PDF`}</p>
      ) : null}
      {showText ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto px-6 py-4">
          {pageOcr ? (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span
                data-testid="law-pdf-ocr-badge"
                className="rounded-sm border border-border px-1.5 py-0.5 text-label text-muted-foreground"
              >
                {t`OCR`}
              </span>
              <p data-testid="law-pdf-ocr-caveat" className="text-body-sm text-muted-foreground">
                {t`Text was read by OCR and may contain errors.`}
              </p>
            </div>
          ) : null}
          <pre
            data-testid="law-pdf-extracted-text"
            className="whitespace-pre-wrap text-body text-foreground"
          >
            {pageText ?? ""}
          </pre>
        </div>
      ) : iframeSrc ? (
        <iframe
          key={`${blobUrl}-${currentPage}`}
          ref={iframeRef}
          title={doc.title}
          src={iframeSrc}
          data-testid="law-pdf-iframe"
          className="min-h-0 flex-1 w-full border-0"
        />
      ) : !loadError ? (
        <p className="px-6 py-10 text-center text-body-sm text-muted-foreground">{t`Loading…`}</p>
      ) : null}
    </div>
  );
}
