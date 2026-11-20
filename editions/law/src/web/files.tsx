// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { t } from "@lingui/core/macro";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Textarea,
} from "@rakazo/ui-web";
import { Download, File, FileCode2, FileImage, FileText, FileType2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { LawPdfViewer } from "./pdf-viewer.js";

export interface LawFileDoc {
  id: string;
  title: string;
  filename: string;
  kind: string;
  body: string;
  version: number;
  rootId: string;
  createdAt?: string;
  source?: string;
  mimeType?: string;
  sizeBytes?: number;
  status?: string;
  statusDetail?: string;
  pageCount?: number | null;
  durationMs?: number | null;
  hasOriginal?: boolean;
  hasSearchable?: boolean;
}

export function fileExtension(filename: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return match?.[1]?.toLowerCase() ?? "txt";
}

export function isEditableLawFile(filename: string): boolean {
  const ext = fileExtension(filename);
  return ext === "md" || ext === "markdown" || ext === "docx";
}

/** Text notes and drafts the editor can open; binary originals stay download-only. */
export function isEditableLawDocument(doc: LawFileDoc): boolean {
  const source = doc.source ?? "";
  if (source === "note" || source === "edit" || source === "bot") return true;
  if (doc.kind === "note" || doc.kind === "review") return true;
  return isEditableLawFile(doc.filename);
}

/** Prefer the text body viewer for notes and extracted text; otherwise the original card. */
export function isTextLawDocument(doc: LawFileDoc): boolean {
  if (isEditableLawDocument(doc)) return true;
  const mime = (doc.mimeType ?? "").toLowerCase();
  if (mime.startsWith("text/") || mime === "application/json") return true;
  return Boolean(doc.body) && !doc.hasOriginal;
}

export function formatLawFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function FileTypeIcon({ filename }: { filename: string }) {
  const ext = fileExtension(filename);
  const props = { size: 18, strokeWidth: 1.7, "aria-hidden": true as const };
  if (ext === "pdf") return <FileType2 {...props} className="text-destructive" />;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) {
    return <FileImage {...props} className="text-muted-foreground" />;
  }
  if (ext === "md" || ext === "markdown") {
    return <FileCode2 {...props} className="text-muted-foreground" />;
  }
  if (ext === "docx" || ext === "doc" || ext === "txt") {
    return <FileText {...props} className="text-muted-foreground" />;
  }
  return <File {...props} className="text-muted-foreground" />;
}

function downloadLawFile(doc: LawFileDoc) {
  const ext = fileExtension(doc.filename);
  let blob: Blob;
  if (ext === "docx") {
    blob = new Blob([wordHtmlDocument(doc.title, doc.body)], {
      type: "application/msword",
    });
  } else if (ext === "md" || ext === "markdown") {
    blob = new Blob([doc.body], { type: "text/markdown;charset=utf-8" });
  } else if (ext === "pdf") {
    blob = new Blob([doc.body], { type: "application/pdf" });
  } else {
    blob = new Blob([doc.body], { type: "text/plain;charset=utf-8" });
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = doc.filename || `${doc.title}.${ext}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function wordHtmlDocument(title: string, body: string): string {
  const escaped = body
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", "<br>");
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${title.replaceAll("<", "")}</title></head><body><p>${escaped}</p></body></html>`;
}

export function LawFileCard({
  doc,
  onOpen,
  editableHint,
}: {
  doc: LawFileDoc;
  onOpen: (doc: LawFileDoc) => void;
  editableHint?: boolean;
}) {
  const ext = fileExtension(doc.filename);
  const open = () => onOpen(doc);
  return (
    <li>
      <div
        data-testid={`law-file-card-${doc.id}`}
        className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-sidebar-accent"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded border border-border bg-card">
          <FileTypeIcon filename={doc.filename} />
        </span>
        <button
          type="button"
          className="min-w-0 flex-1 rounded-sm text-start focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-foreground/50 focus-visible:outline-none"
          onClick={open}
          aria-label={doc.title}
        >
          <span className="block truncate text-body-sm text-foreground">{doc.title}</span>
          <span className="block truncate text-label text-muted-foreground">
            .{ext}
            {doc.version > 1 ? ` · v${doc.version}` : ""}
            {editableHint ? t` · edit` : ""}
          </span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0 text-muted-foreground focus-visible:ring-inset focus-visible:ring-foreground/50"
          aria-label={t`Download ${doc.filename}`}
          data-testid={`law-file-download-${doc.id}`}
          onClick={(event) => {
            event.stopPropagation();
            downloadLawFile(doc);
          }}
        >
          <Download size={14} strokeWidth={1.8} aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

export function isPdfLawDocument(doc: LawFileDoc): boolean {
  const mime = (doc.mimeType ?? "").toLowerCase();
  if (mime === "application/pdf") return true;
  return fileExtension(doc.filename) === "pdf";
}

function isDocxLawFile(doc: LawFileDoc): boolean {
  const ext = fileExtension(doc.filename);
  const mime = (doc.mimeType ?? "").toLowerCase();
  return (
    ext === "docx" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}

export function LawFileViewer({
  doc,
  onClose,
  onEdit,
  originalHref,
  caseId,
  spaceId,
  page,
}: {
  doc: LawFileDoc;
  onClose: () => void;
  onEdit?: () => void;
  /** When set, Download / Download original use the stored file bytes. */
  originalHref?: string;
  caseId?: string;
  spaceId?: string | null;
  /** Physical page for PDF deep links. */
  page?: number;
}) {
  const textView = isTextLawDocument(doc);
  const pdfView = isPdfLawDocument(doc) && Boolean(caseId) && Boolean(doc.hasOriginal);
  const fromDocx = isDocxLawFile(doc) && Boolean(doc.body);
  const sizeLabel = doc.sizeBytes ? formatLawFileSize(doc.sizeBytes) : "";
  const typeLabel = doc.mimeType || fileExtension(doc.filename).toUpperCase();

  function download() {
    if (originalHref) {
      const anchor = document.createElement("a");
      anchor.href = originalHref;
      anchor.download = doc.filename || doc.title;
      anchor.rel = "noopener";
      anchor.click();
      return;
    }
    downloadLawFile(doc);
  }

  return (
    <LawOverlay
      title={doc.title}
      subtitle={`${doc.filename}${doc.version > 1 ? ` · v${doc.version}` : ""}`}
      onClose={onClose}
      actions={
        pdfView ? null : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={download}
              data-testid="law-viewer-download"
            >
              {originalHref ? t`Download original` : t`Download`}
            </Button>
            {onEdit && textView ? (
              <Button type="button" size="sm" onClick={onEdit} data-testid="law-viewer-edit">
                {t`Edit`}
              </Button>
            ) : null}
          </>
        )
      }
    >
      {pdfView && caseId ? (
        <LawPdfViewer doc={doc} caseId={caseId} spaceId={spaceId ?? null} page={page} />
      ) : textView ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {fromDocx ? (
            <p
              data-testid="law-viewer-docx-chip"
              className="shrink-0 border-b border-border px-6 py-2 text-label text-muted-foreground"
            >
              {t`Extracted from .docx`}
            </p>
          ) : null}
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-6 py-4 text-body text-foreground">
            {doc.body}
          </pre>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
          <div
            data-testid="law-viewer-original-card"
            className="flex w-full max-w-sm flex-col items-center gap-3 rounded-lg border border-border bg-card px-6 py-8 text-center"
          >
            <p className="text-body text-foreground">{typeLabel}</p>
            {sizeLabel ? <p className="text-body-sm text-muted-foreground">{sizeLabel}</p> : null}
            <Button
              type="button"
              size="sm"
              onClick={download}
              data-testid="law-viewer-download-original"
            >
              {t`Download original`}
            </Button>
          </div>
        </div>
      )}
    </LawOverlay>
  );
}

export function LawDocumentEditor({
  doc,
  onClose,
  onSave,
}: {
  doc: LawFileDoc;
  onClose: () => void;
  onSave: (body: string) => Promise<void>;
}) {
  const [value, setValue] = useState(doc.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const dirty = value !== doc.body;

  useEffect(() => {
    setValue(doc.body);
    setError(null);
  }, [doc.body, doc.id]);

  const docxSubtitle = isDocxLawFile(doc)
    ? t`Editing the extracted text; the original .docx is kept`
    : t`Editing ${doc.filename} · saves as v${doc.version + 1}`;

  return (
    <LawOverlay
      title={doc.title}
      subtitle={docxSubtitle}
      onClose={onClose}
      dirty={dirty}
      actions={
        <Button
          type="button"
          size="sm"
          disabled={saving || !dirty}
          data-testid="law-editor-save"
          onClick={() => {
            setSaving(true);
            setError(null);
            void onSave(value)
              .catch((caught: unknown) => {
                setError(caught instanceof Error ? caught.message : t`Couldn't save`);
              })
              .finally(() => setSaving(false));
          }}
        >
          {saving ? t`Saving…` : t`Save version`}
        </Button>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col bg-muted/40 px-4 py-4">
        <div
          ref={surface}
          className="mx-auto flex min-h-0 w-full max-w-[720px] flex-1 flex-col rounded-sm border border-border bg-card shadow-sm"
        >
          <label className="sr-only" htmlFor="law-doc-editor">
            {t`Document body`}
          </label>
          <Textarea
            id="law-doc-editor"
            data-testid="law-doc-editor"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-10 py-8 text-body leading-relaxed shadow-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-foreground/50"
            spellCheck
          />
        </div>
        {error ? <p className="mt-2 text-center text-body-sm text-destructive">{error}</p> : null}
      </div>
    </LawOverlay>
  );
}

function LawOverlay({
  title,
  subtitle,
  onClose,
  actions,
  children,
  dirty = false,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
  dirty?: boolean;
}) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
      >
        <DialogContent
          showCloseButton={false}
          data-testid="law-file-overlay"
          aria-label={title}
          className="flex h-[min(860px,92vh)] w-[min(880px,96vw)] max-w-[min(880px,96vw)] flex-col gap-0 overflow-hidden rounded-lg border border-border bg-background p-0 shadow-lg sm:max-w-[min(880px,96vw)]"
        >
          <DialogHeader className="flex flex-row items-center gap-3 space-y-0 border-b border-border px-4 py-3 text-start">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-body font-medium text-foreground">
                {title}
              </DialogTitle>
              <DialogDescription className="truncate text-label text-muted-foreground">
                {subtitle}
              </DialogDescription>
            </div>
            {actions}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t`Close`}
              onClick={requestClose}
              data-testid="law-overlay-close"
            >
              <X size={16} strokeWidth={1.8} aria-hidden="true" />
            </Button>
          </DialogHeader>
          {children}
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Discard changes?`}</AlertDialogTitle>
            <AlertDialogDescription>{t`Your edits will be lost.`}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t`Cancel`}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmDiscard(false);
                onClose();
              }}
            >
              {t`Discard`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Keep the newest version of each document root. */
export function latestLawDocuments(docs: readonly LawFileDoc[]): LawFileDoc[] {
  const byRoot = new Map<string, LawFileDoc>();
  for (const doc of docs) {
    const root = doc.rootId || doc.id;
    const current = byRoot.get(root);
    if (!current || doc.version >= current.version) byRoot.set(root, { ...doc, rootId: root });
  }
  return [...byRoot.values()];
}
