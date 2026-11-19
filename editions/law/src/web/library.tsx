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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
  Input,
  SectionHeading,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  toast,
} from "@rakazo/ui-web";
import { MoreHorizontal, Plus } from "lucide-react";
import type { ChangeEvent, DragEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { LawFileDoc } from "./files.js";
import {
  fileExtension,
  formatLawFileSize,
  isEditableLawDocument,
  LawDocumentEditor,
  LawFileCard,
  LawFileViewer,
  latestLawDocuments,
} from "./files.js";
import { uploadLawDocument, withSpaceHeaders } from "./lib.js";

/** Focus ring that meets 3:1 against sidebar and accent fills (ring-ring/50 does not). */
const LAW_FOCUS =
  "focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-foreground/50 focus-visible:outline-none";

const POLL_START_MS = 3_000;
const POLL_MAX_MS = 15_000;
const UPLOAD_CONCURRENCY = 2;

type PendingUpload = {
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

function isLibraryKind(kind: string): boolean {
  return kind !== "review";
}

function isPendingStatus(status: string | undefined): boolean {
  return status === "queued" || status === "processing";
}

function sortNewestFirst(docs: LawFileDoc[]): LawFileDoc[] {
  return [...docs].sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    if (tb !== ta) return tb - ta;
    return b.id.localeCompare(a.id);
  });
}

function originalFileHref(caseId: string, docId: string): string {
  return `/api/law/cases/${caseId}/documents/${docId}/file`;
}

function isFileDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return [...dataTransfer.types].includes("Files");
}

export function LawCaseDocuments({
  caseId,
  spaceId,
  shellError,
  reload,
}: {
  caseId: string;
  spaceId: string | null;
  shellError: string | null;
  reload: () => void;
}) {
  const [documents, setDocuments] = useState<LawFileDoc[]>([]);
  const [docCaseId, setDocCaseId] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<LawFileDoc | null>(null);
  const [editor, setEditor] = useState<{ doc: LawFileDoc; caseId: string } | null>(null);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LawFileDoc | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLElement>(null);
  const dragDepth = useRef(0);
  const uploadQueue = useRef<PendingUpload[]>([]);
  const activeUploads = useRef(0);
  const pollDelay = useRef(POLL_START_MS);

  const loadDocuments = useRef(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/law/cases/${caseId}/documents`, {
      credentials: "same-origin",
      headers: withSpaceHeaders(undefined, spaceId),
      signal,
    });
    if (!response.ok) throw new Error(String(response.status));
    return (await response.json()) as { documents: LawFileDoc[] };
  });
  loadDocuments.current = async (signal?: AbortSignal) => {
    const response = await fetch(`/api/law/cases/${caseId}/documents`, {
      credentials: "same-origin",
      headers: withSpaceHeaders(undefined, spaceId),
      signal,
    });
    if (!response.ok) throw new Error(String(response.status));
    return (await response.json()) as { documents: LawFileDoc[] };
  };

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void loadDocuments
      .current(controller.signal)
      .then((body) => {
        if (cancelled || controller.signal.aborted) return;
        setDocuments(body.documents);
        setDocCaseId(caseId);
        setDocError(null);
        pollDelay.current = POLL_START_MS;
      })
      .catch((caught: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setDocuments([]);
        setDocCaseId(caseId);
        setDocError(caught instanceof Error ? caught.message : "error");
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [caseId, spaceId]);

  const visible = docCaseId === caseId ? documents : [];
  const heads = latestLawDocuments(visible);
  const library = sortNewestFirst(heads.filter((doc) => isLibraryKind(doc.kind)));
  const review = heads.filter((doc) => doc.kind === "review");
  const needsPoll = library.some((doc) => isPendingStatus(doc.status));

  // Poll while any library row is queued/processing; backoff 3s → 15s; pause when hidden.
  useEffect(() => {
    if (!needsPoll) {
      pollDelay.current = POLL_START_MS;
      return;
    }
    let cancelled = false;
    let timer: number | null = null;

    const schedule = () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") return;
      timer = window.setTimeout(() => {
        void loadDocuments
          .current()
          .then((body) => {
            if (cancelled) return;
            setDocuments(body.documents);
            setDocCaseId(caseId);
            setDocError(null);
            const still = body.documents.some(
              (doc) => isLibraryKind(doc.kind) && isPendingStatus(doc.status),
            );
            if (still) {
              pollDelay.current = Math.min(POLL_MAX_MS, pollDelay.current + 2_000);
              schedule();
            } else {
              pollDelay.current = POLL_START_MS;
            }
          })
          .catch(() => {
            if (cancelled) return;
            pollDelay.current = Math.min(POLL_MAX_MS, pollDelay.current + 2_000);
            schedule();
          });
      }, pollDelay.current);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible" && needsPoll) schedule();
      else if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [needsPoll, caseId, spaceId]);

  // Window dragover: only while this column is mounted and the drag carries files,
  // and only when the pointer is over the library — do not hijack drops elsewhere.
  useEffect(() => {
    const onDragOver = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      const root = libraryRef.current;
      if (!root) return;
      const target = event.target;
      if (!(target instanceof Node) || !root.contains(target)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    window.addEventListener("dragover", onDragOver);
    return () => window.removeEventListener("dragover", onDragOver);
  }, []);

  function pumpUploads() {
    while (activeUploads.current < UPLOAD_CONCURRENCY && uploadQueue.current.length > 0) {
      const next = uploadQueue.current.shift();
      if (!next) break;
      activeUploads.current += 1;
      void runUpload(next).finally(() => {
        activeUploads.current -= 1;
        pumpUploads();
      });
    }
  }

  async function runUpload(item: PendingUpload) {
    setPending((current) =>
      current.map((row) => (row.localId === item.localId ? { ...row, progress: null } : row)),
    );
    try {
      const result = await uploadLawDocument({
        caseId,
        file: item.file,
        spaceId,
        onProgress: (fraction) => {
          setPending((current) =>
            current.map((row) =>
              row.localId === item.localId ? { ...row, progress: fraction } : row,
            ),
          );
        },
      });
      if (result.ok) {
        const document = result.document as LawFileDoc;
        setPending((current) => current.filter((row) => row.localId !== item.localId));
        setDocuments((current) => {
          if (current.some((doc) => doc.id === document.id)) return current;
          return [...current, document];
        });
        setDocCaseId(caseId);
        return;
      }
      setPending((current) =>
        current.map((row) =>
          row.localId === item.localId
            ? {
                ...row,
                progress: null,
                error:
                  result.status === 413
                    ? result.error || t`File too large`
                    : result.error || t`Couldn't upload`,
                status: result.status,
                existingId: result.existingId,
              }
            : row,
        ),
      );
    } catch {
      setPending((current) =>
        current.map((row) =>
          row.localId === item.localId
            ? { ...row, progress: null, error: t`Couldn't upload` }
            : row,
        ),
      );
    }
  }

  function enqueueFiles(fileList: FileList | File[]) {
    const files = [...fileList];
    if (files.length === 0) return;
    const rows: PendingUpload[] = files.map((file) => ({
      localId: `upload-${crypto.randomUUID()}`,
      title: file.name.replace(/\.[^.]+$/, "") || file.name || t`Upload`,
      filename: file.name || "upload",
      progress: 0,
      file,
    }));
    setPending((current) => [...rows, ...current]);
    uploadQueue.current.push(...rows);
    pumpUploads();
  }

  function retryUpload(localId: string) {
    setPending((current) => {
      const row = current.find((item) => item.localId === localId);
      if (!row) return current;
      const next = {
        ...row,
        error: undefined,
        status: undefined,
        existingId: undefined,
        progress: 0,
      };
      uploadQueue.current.push(next);
      queueMicrotask(() => pumpUploads());
      return current.map((item) => (item.localId === localId ? next : item));
    });
  }

  async function createNote() {
    const title = noteTitle.trim();
    if (!title) {
      setNoteError(t`Enter a title`);
      return;
    }
    setNoteBusy(true);
    setNoteError(null);
    try {
      const response = await fetch(`/api/law/cases/${caseId}/documents`, {
        method: "POST",
        credentials: "same-origin",
        headers: withSpaceHeaders({ "content-type": "application/json" }, spaceId),
        body: JSON.stringify({ title }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        document?: LawFileDoc;
        error?: string;
      };
      if (!response.ok || !body.document) {
        setNoteError(body.error || t`Couldn't create document`);
        return;
      }
      setDocuments((current) => [...current, body.document!]);
      setDocCaseId(caseId);
      setNoteOpen(false);
      setNoteTitle("");
      setEditor({ doc: body.document, caseId });
    } catch {
      setNoteError(t`Couldn't create document`);
    } finally {
      setNoteBusy(false);
    }
  }

  async function renameDocument(doc: LawFileDoc, title: string) {
    const trimmed = title.trim();
    if (!trimmed) throw new Error(t`Enter a title`);
    const response = await fetch(`/api/law/cases/${caseId}/documents/${doc.id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: withSpaceHeaders({ "content-type": "application/json" }, spaceId),
      body: JSON.stringify({ title: trimmed }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      document?: LawFileDoc;
      error?: string;
    };
    if (!response.ok || !body.document) {
      throw new Error(body.error || t`Couldn't rename`);
    }
    setDocuments((current) =>
      current.map((item) =>
        item.rootId === doc.rootId || item.id === doc.id
          ? { ...item, title: body.document!.title }
          : item,
      ),
    );
    return body.document;
  }

  async function deleteDocument(doc: LawFileDoc) {
    const response = await fetch(`/api/law/cases/${caseId}/documents/${doc.id}`, {
      method: "DELETE",
      credentials: "same-origin",
      headers: withSpaceHeaders(undefined, spaceId),
    });
    if (!response.ok && response.status !== 204) {
      throw new Error(t`Couldn't delete`);
    }
    setDocuments((current) =>
      current.filter((item) => item.rootId !== doc.rootId && item.id !== doc.id),
    );
    if (viewer?.id === doc.id || viewer?.rootId === doc.rootId) setViewer(null);
    if (editor?.doc.id === doc.id) setEditor(null);
    toast(t`Deleted`);
  }

  async function saveVersion(body: string) {
    if (!editor || editor.caseId !== caseId) return;
    const response = await fetch(
      `/api/law/cases/${editor.caseId}/documents/${editor.doc.id}/versions`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: withSpaceHeaders({ "content-type": "application/json" }, spaceId),
        body: JSON.stringify({ body }),
      },
    );
    if (!response.ok) throw new Error(String(response.status));
    const payload = (await response.json()) as { document: LawFileDoc };
    setDocuments((current) => [...current, payload.document]);
    setDocCaseId(editor.caseId);
    setEditor(null);
    setViewer(payload.document);
  }

  function openExisting(existingId: string) {
    const found = documents.find((doc) => doc.id === existingId);
    if (found) setViewer(found);
    else {
      void loadDocuments.current().then((body) => {
        setDocuments(body.documents);
        const match = body.documents.find((doc) => doc.id === existingId);
        if (match) setViewer(match);
      });
    }
  }

  function onLibraryDragEnter(event: DragEvent<HTMLElement>) {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function onLibraryDragOver(event: DragEvent<HTMLElement>) {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }

  function onLibraryDragLeave(event: DragEvent<HTMLElement>) {
    if (!isFileDrag(event.dataTransfer)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onLibraryDrop(event: DragEvent<HTMLElement>) {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (event.dataTransfer.files.length > 0) enqueueFiles(event.dataTransfer.files);
  }

  const showEmpty = library.length === 0 && pending.length === 0;

  return (
    <>
      <aside
        data-testid="law-column"
        className="hidden h-full w-[280px] shrink-0 flex-col border-s border-sidebar-border bg-background md:flex"
      >
        <section
          ref={libraryRef}
          data-testid="law-library"
          aria-label={t`Library`}
          className={`relative flex min-h-0 flex-1 flex-col border-t border-border p-3 first:border-t-0 ${
            dragging ? "ring-2 ring-inset ring-foreground/50" : ""
          }`}
        >
          <fieldset
            aria-label={t`Drop files to add to this case`}
            className="flex min-h-0 flex-1 flex-col border-0 p-0"
            onDragEnter={onLibraryDragEnter}
            onDragOver={onLibraryDragOver}
            onDragLeave={onLibraryDragLeave}
            onDrop={onLibraryDrop}
          >
            <div className="flex items-center gap-2">
              <SectionHeading as="h2" variant="label" className="min-w-0 flex-1 truncate">
                {t`Library`}
              </SectionHeading>
              <Tooltip>
                <DropdownMenu>
                  <TooltipTrigger
                    render={
                      <DropdownMenuTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className={`size-7 shrink-0 text-muted-foreground ${LAW_FOCUS}`}
                            aria-label={t`Add to library`}
                            data-testid="law-library-add"
                          />
                        }
                      >
                        <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
                      </DropdownMenuTrigger>
                    }
                  />
                  <DropdownMenuContent align="end" className="min-w-40">
                    <DropdownMenuItem
                      data-testid="law-library-upload-files"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {t`Upload files`}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid="law-library-new-note"
                      onClick={() => {
                        setNoteTitle("");
                        setNoteError(null);
                        setNoteOpen(true);
                      }}
                    >
                      {t`New note`}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <TooltipContent>{t`Add to library`}</TooltipContent>
              </Tooltip>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="sr-only"
                data-testid="law-library-file-input"
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  if (event.target.files?.length) enqueueFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>

            {dragging ? (
              <div
                data-testid="law-library-drop-target"
                className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-md border-2 border-foreground/50 bg-background/90 text-center text-body-sm text-foreground [@media(hover:none)]:hidden"
              >
                {t`Drop files to add to this case`}
              </div>
            ) : null}

            {showEmpty ? (
              <Empty data-testid="law-library-empty" className="mt-2 border-0 p-4">
                <EmptyHeader>
                  <EmptyTitle className="text-body-sm font-normal text-muted-foreground">
                    {t`No files in this case yet`}
                  </EmptyTitle>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className={LAW_FOCUS}
                    data-testid="law-library-empty-add"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {t`Add files`}
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              <ul className="mt-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden">
                {pending.map((row) => (
                  <PendingUploadRow
                    key={row.localId}
                    row={row}
                    onRetry={() => retryUpload(row.localId)}
                    onOpenExisting={
                      row.existingId ? () => openExisting(row.existingId!) : undefined
                    }
                  />
                ))}
                {library.map((doc) => (
                  <LibraryFileRow
                    key={doc.id}
                    caseId={caseId}
                    spaceId={spaceId}
                    doc={doc}
                    renaming={renamingId === doc.id}
                    onOpen={() => setViewer(doc)}
                    onStartRename={() => setRenamingId(doc.id)}
                    onCancelRename={() => setRenamingId(null)}
                    onRename={async (title) => {
                      await renameDocument(doc, title);
                      setRenamingId(null);
                    }}
                    onDelete={() => setDeleteTarget(doc)}
                  />
                ))}
              </ul>
            )}
          </fieldset>
        </section>

        <LawReviewPanel
          docs={review}
          onOpen={(doc) => {
            if (isEditableLawDocument(doc)) setEditor({ doc, caseId });
            else setViewer(doc);
          }}
        />

        <section
          data-testid="law-something-else"
          className="flex min-h-0 flex-1 flex-col border-t border-border p-3"
        >
          <SectionHeading as="h2" variant="label">
            {t`Something else`}
          </SectionHeading>
        </section>
        {shellError || docError ? (
          <button
            type="button"
            className={`border-t border-border px-3 py-2 text-start text-body-sm underline ${LAW_FOCUS}`}
            onClick={reload}
          >
            {t`Retry`}
          </button>
        ) : null}
      </aside>

      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent className="sm:max-w-sm" data-testid="law-library-note-dialog">
          <DialogHeader>
            <DialogTitle>{t`New note`}</DialogTitle>
          </DialogHeader>
          <label className="sr-only" htmlFor="law-library-note-title">
            {t`Title`}
          </label>
          <Input
            id="law-library-note-title"
            data-testid="law-library-note-title"
            value={noteTitle}
            onChange={(event) => setNoteTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void createNote();
              }
            }}
            placeholder={t`Title`}
            className={LAW_FOCUS}
            autoFocus
          />
          {noteError ? <p className="text-body-sm text-destructive">{noteError}</p> : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setNoteOpen(false)}
              disabled={noteBusy}
            >
              {t`Cancel`}
            </Button>
            <Button
              type="button"
              data-testid="law-library-note-create"
              disabled={noteBusy || !noteTitle.trim()}
              onClick={() => void createNote()}
            >
              {noteBusy ? t`Creating…` : t`Create`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent data-testid="law-library-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget ? t`Delete ${deleteTarget.title}?` : t`Delete?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t`It is removed from this case's Library.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t`Cancel`}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="law-library-delete-confirm-button"
              onClick={() => {
                const target = deleteTarget;
                setDeleteTarget(null);
                if (target) void deleteDocument(target).catch(() => toast(t`Couldn't delete`));
              }}
            >
              {t`Delete`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {viewer ? (
        <LawFileViewer
          doc={viewer}
          onClose={() => setViewer(null)}
          originalHref={viewer.hasOriginal ? originalFileHref(caseId, viewer.id) : undefined}
          onEdit={
            isEditableLawDocument(viewer)
              ? () => {
                  setEditor({ doc: viewer, caseId });
                  setViewer(null);
                }
              : undefined
          }
        />
      ) : null}
      {editor ? (
        <LawDocumentEditor doc={editor.doc} onClose={() => setEditor(null)} onSave={saveVersion} />
      ) : null}
    </>
  );
}

function LawReviewPanel({
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

function PendingUploadRow({
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

function LibraryFileRow({
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
