// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { Button } from "@rakazo/ui-web";
import { Download, File, FileCode2, FileImage, FileText, FileType2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

export interface LawFileDoc {
  id: string;
  title: string;
  filename: string;
  kind: string;
  body: string;
  version: number;
  rootId: string;
}

export function fileExtension(filename: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return match?.[1]?.toLowerCase() ?? "txt";
}

export function isEditableLawFile(filename: string): boolean {
  const ext = fileExtension(filename);
  return ext === "md" || ext === "markdown" || ext === "docx";
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
          className="min-w-0 flex-1 text-start"
          onDoubleClick={() => onOpen(doc)}
          aria-label={doc.title}
        >
          <span className="block truncate text-body-sm text-foreground">{doc.title}</span>
          <span className="block truncate text-label text-muted-foreground">
            .{ext}
            {doc.version > 1 ? ` · v${doc.version}` : ""}
            {editableHint ? " · edit" : ""}
          </span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0 text-muted-foreground opacity-70 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={`Download ${doc.filename}`}
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

export function LawFileViewer({
  doc,
  onClose,
  onEdit,
}: {
  doc: LawFileDoc;
  onClose: () => void;
  onEdit?: () => void;
}) {
  return (
    <LawOverlay
      title={doc.title}
      subtitle={`${doc.filename}${doc.version > 1 ? ` · v${doc.version}` : ""}`}
      onClose={onClose}
      actions={
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => downloadLawFile(doc)}
            data-testid="law-viewer-download"
          >
            Download
          </Button>
          {onEdit ? (
            <Button type="button" size="sm" onClick={onEdit} data-testid="law-viewer-edit">
              Edit
            </Button>
          ) : null}
        </>
      }
    >
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-6 py-4 text-body text-foreground">
        {doc.body}
      </pre>
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

  useEffect(() => {
    setValue(doc.body);
    setError(null);
  }, [doc.body, doc.id]);

  return (
    <LawOverlay
      title={doc.title}
      subtitle={`Editing ${doc.filename} · saves as v${doc.version + 1}`}
      onClose={onClose}
      actions={
        <Button
          type="button"
          size="sm"
          disabled={saving || value === doc.body}
          data-testid="law-editor-save"
          onClick={() => {
            setSaving(true);
            setError(null);
            void onSave(value)
              .catch((caught: unknown) => {
                setError(caught instanceof Error ? caught.message : "Couldn't save");
              })
              .finally(() => setSaving(false));
          }}
        >
          {saving ? "Saving…" : "Save version"}
        </Button>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col bg-muted/40 px-4 py-4">
        <div
          ref={surface}
          className="mx-auto flex min-h-0 w-full max-w-[720px] flex-1 flex-col rounded-sm border border-border bg-card shadow-sm"
        >
          <label className="sr-only" htmlFor="law-doc-editor">
            Document body
          </label>
          <textarea
            id="law-doc-editor"
            data-testid="law-doc-editor"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="min-h-0 flex-1 resize-none bg-transparent px-10 py-8 text-body leading-relaxed text-foreground outline-none"
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
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="law-file-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="flex h-[min(860px,92vh)] w-[min(880px,96vw)] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg">
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-body font-medium text-foreground">{title}</h2>
            <p className="truncate text-label text-muted-foreground">{subtitle}</p>
          </div>
          {actions}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            onClick={onClose}
            data-testid="law-overlay-close"
          >
            <X size={16} strokeWidth={1.8} aria-hidden="true" />
          </Button>
        </header>
        {children}
      </div>
    </div>
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
