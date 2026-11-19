// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { t } from "@lingui/core/macro";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  SectionHeading,
  Spinner,
  toast,
} from "@rakazo/ui-web";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LawFileDoc } from "./files.js";
import { fileExtension, formatLawFileSize, isEditableLawDocument, LawFileCard } from "./files.js";
import { withSpaceHeaders } from "./lib.js";

/** Focus ring that meets 3:1 against sidebar and accent fills (ring-ring/50 does not). */
export const LAW_FOCUS =
  "focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-foreground/50 focus-visible:outline-none";

export type PendingUpload = {
  localId: string;
  title: string;
  filename: string;
  /** 0–1, or null while indeterminate. */
  progress: number | null;
  error?: string;
  status?: number;
  existingId?: string;
  file: File;
};

export function isPendingStatus(status: string | undefined): boolean {
  return status === "queued" || status === "processing";
}

export function originalFileHref(caseId: string, docId: string): string {
  return `/api/law/cases/${caseId}/documents/${docId}/file`;
}

export function LawReviewPanel({
  docs,
  onOpen,
}: {
  docs: LawFileDoc[];
  onOpen: (doc: LawFileDoc) => void;
}) {
  return (
    <section
      data-testid="law-review"
      className="flex min-h-0 flex-1 flex-col border-t border-border p-3"
    >
      <SectionHeading as="h2" variant="label">
        {t`Documents for review`}
      </SectionHeading>
      <ul className="mt-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {docs.map((doc) => (
          <LawFileCard
            key={doc.id}
            doc={doc}
            onOpen={onOpen}
            editableHint={isEditableLawDocument(doc)}
          />
        ))}
      </ul>
    </section>
  );
}

export function PendingUploadRow({
  row,
  onRetry,
  onOpenExisting,
}: {
  row: PendingUpload;
  onRetry: () => void;
  onOpenExisting?: () => void;
}) {
  const percent =
    row.progress === null || row.progress === undefined ? null : Math.round(row.progress * 100);
  return (
    <li>
      <div
        data-testid={`law-upload-progress-${row.localId}`}
        className="flex items-center gap-2 rounded-md px-1.5 py-1.5"
      >
        <span className="flex size-8 shrink-0 items-center justify-center">
          {row.error ? null : <Spinner className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-body-sm text-foreground">{row.title}</span>
          {row.error ? (
            <span className="block truncate text-label text-destructive">
              {row.error}
              {row.status === 409 && onOpenExisting ? (
                <>
                  {" · "}
                  <button
                    type="button"
                    className={`underline ${LAW_FOCUS}`}
                    data-testid={`law-upload-open-existing-${row.localId}`}
                    onClick={onOpenExisting}
                  >
                    {t`Open existing`}
                  </button>
                </>
              ) : null}
              {row.status !== 409 ? (
                <>
                  {" · "}
                  <button
                    type="button"
                    className={`underline ${LAW_FOCUS}`}
                    data-testid={`law-upload-retry-${row.localId}`}
                    onClick={onRetry}
                  >
                    {t`Retry`}
                  </button>
                </>
              ) : null}
            </span>
          ) : (
            <span className="block truncate text-label text-muted-foreground">
              {percent === null ? t`Uploading…` : t`Uploading ${percent}%`}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

export function LibraryFileRow({
  caseId,
  spaceId,
  doc,
  renaming,
  onOpen,
  onStartRename,
  onCancelRename,
  onRename,
  onDelete,
}: {
  caseId: string;
  spaceId: string | null;
  doc: LawFileDoc;
  renaming: boolean;
  onOpen: () => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onRename: (title: string) => Promise<void>;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(doc.title);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const ext = fileExtension(doc.filename);
  const sizeLabel = doc.sizeBytes ? formatLawFileSize(doc.sizeBytes) : "";
  const pending = isPendingStatus(doc.status);

  useEffect(() => {
    if (!renaming) return;
    setDraft(doc.title);
    setRenameError(null);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [renaming, doc.title]);

  async function saveRename() {
    try {
      await onRename(draft);
    } catch (caught: unknown) {
      setRenameError(caught instanceof Error ? caught.message : t`Couldn't rename`);
    }
  }

  function download() {
    if (doc.hasOriginal) {
      const anchor = document.createElement("a");
      anchor.href = originalFileHref(caseId, doc.id);
      anchor.download = doc.filename || doc.title;
      anchor.rel = "noopener";
      // Space header cannot go on a navigation; open with fetch blob when needed.
      void fetch(originalFileHref(caseId, doc.id), {
        credentials: "same-origin",
        headers: withSpaceHeaders(undefined, spaceId),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(String(response.status));
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          anchor.href = url;
          anchor.click();
          URL.revokeObjectURL(url);
        })
        .catch(() => toast(t`Couldn't download`));
      return;
    }
    const blob = new Blob([doc.body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = doc.filename || `${doc.title}.${ext}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <li>
      <div
        data-testid={`law-file-card-${doc.id}`}
        className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-sidebar-accent"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded border border-border bg-card">
          {pending ? <Spinner className="size-4" /> : null}
          {!pending ? (
            <span className="text-label uppercase text-muted-foreground">{ext}</span>
          ) : null}
        </span>
        {renaming ? (
          <div className="min-w-0 flex-1">
            <Input
              ref={inputRef}
              data-testid={`law-library-rename-input-${doc.id}`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  onCancelRename();
                }
              }}
              onBlur={() => {
                if (draft.trim() && draft.trim() !== doc.title) void saveRename();
                else onCancelRename();
              }}
              aria-label={t`Rename ${doc.title}`}
              className={`h-7 ${LAW_FOCUS}`}
            />
            {renameError ? (
              <span className="block text-label text-destructive">{renameError}</span>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            className={`min-w-0 flex-1 rounded-sm text-start ${LAW_FOCUS}`}
            onClick={onOpen}
            aria-label={doc.title}
          >
            <span className="block truncate text-body-sm text-foreground">{doc.title}</span>
            <span className="block truncate text-label text-muted-foreground">
              {pending && doc.statusDetail
                ? doc.statusDetail
                : doc.status === "failed" && doc.statusDetail
                  ? doc.statusDetail
                  : [`.${ext}`, sizeLabel, doc.version > 1 ? `v${doc.version}` : ""]
                      .filter(Boolean)
                      .join(" · ")}
            </span>
          </button>
        )}
        {!renaming ? (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={`size-7 shrink-0 text-muted-foreground opacity-100 focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 ${LAW_FOCUS}`}
                  aria-label={t`Actions for ${doc.title}`}
                  data-testid={`law-library-actions-${doc.id}`}
                />
              }
            >
              <MoreHorizontal size={14} strokeWidth={1.8} aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  setMenuOpen(false);
                  onOpen();
                }}
              >
                {t`Open`}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setMenuOpen(false);
                  download();
                }}
              >
                {t`Download`}
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid={`law-library-rename-${doc.id}`}
                onClick={() => {
                  setMenuOpen(false);
                  onStartRename();
                }}
              >
                {t`Rename`}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                data-testid={`law-library-delete-${doc.id}`}
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
              >
                {t`Delete`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </li>
  );
}
