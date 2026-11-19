// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { t } from "@lingui/core/macro";
import { SectionHeading } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import type { LawFileDoc } from "./files.js";
import {
  isEditableLawFile,
  LawDocumentEditor,
  LawFileCard,
  LawFileViewer,
  latestLawDocuments,
} from "./files.js";
import { withSpaceHeaders } from "./lib.js";

/** Focus ring that meets 3:1 against sidebar and accent fills (ring-ring/50 does not). */
const LAW_FOCUS =
  "focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-foreground/50 focus-visible:outline-none";

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

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const load = () => {
      void fetch(`/api/law/cases/${caseId}/documents`, {
        credentials: "same-origin",
        headers: withSpaceHeaders(undefined, spaceId),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(String(response.status));
          return (await response.json()) as { documents: LawFileDoc[] };
        })
        .then((body) => {
          if (cancelled || controller.signal.aborted) return;
          setDocuments(body.documents);
          setDocCaseId(caseId);
          setDocError(null);
        })
        .catch((caught: unknown) => {
          if (cancelled || controller.signal.aborted) return;
          setDocuments([]);
          setDocCaseId(caseId);
          setDocError(caught instanceof Error ? caught.message : "error");
        });
    };
    load();
    const timer = window.setInterval(load, 4_000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [caseId, spaceId]);

  const visible = docCaseId === caseId ? documents : [];
  const heads = latestLawDocuments(visible);
  const library = heads.filter((doc) => doc.kind === "library");
  const review = heads.filter((doc) => doc.kind === "review");

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

  return (
    <>
      <aside
        data-testid="law-column"
        className="hidden h-full w-[280px] shrink-0 flex-col border-s border-sidebar-border bg-background md:flex"
      >
        <LawPanel
          title={t`Library`}
          testId="law-library"
          docs={library}
          onOpen={(doc) => setViewer(doc)}
        />
        <LawPanel
          title={t`Documents for review`}
          testId="law-review"
          docs={review}
          onOpen={(doc) => {
            if (isEditableLawFile(doc.filename)) setEditor({ doc, caseId });
            else setViewer(doc);
          }}
          editable
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
      {viewer ? (
        <LawFileViewer
          doc={viewer}
          onClose={() => setViewer(null)}
          onEdit={
            isEditableLawFile(viewer.filename)
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

function LawPanel({
  title,
  testId,
  docs,
  onOpen,
  editable = false,
}: {
  title: string;
  testId: string;
  docs: LawFileDoc[];
  onOpen: (doc: LawFileDoc) => void;
  editable?: boolean;
}) {
  return (
    <section
      data-testid={testId}
      className="flex min-h-0 flex-1 flex-col border-t border-border p-3 first:border-t-0"
    >
      <SectionHeading as="h2" variant="label">
        {title}
      </SectionHeading>
      <ul className="mt-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {docs.map((doc) => (
          <LawFileCard
            key={doc.id}
            doc={doc}
            onOpen={onOpen}
            editableHint={editable && isEditableLawFile(doc.filename)}
          />
        ))}
      </ul>
    </section>
  );
}
