// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { SectionHeading } from "@rakazo/ui-web";
import { useSidebar } from "@rakazo/ui-web/components/ui/sidebar";
import { Briefcase, Plus, Scale } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { LawFileDoc } from "./files.js";
import {
  isEditableLawFile,
  LawDocumentEditor,
  LawFileCard,
  LawFileViewer,
  latestLawDocuments,
} from "./files.js";
import { selectedSpaceId, withSpaceHeaders } from "./lib.js";
import type { LawEnvironment, LawRosterFilter } from "./roster.js";

interface LawBot {
  role: string;
  name: string;
  botId: string;
}

interface LawCase {
  id: string;
  slug: string;
  name: string;
  bots: LawBot[];
}

interface LawShellValue {
  cases: LawCase[];
  selected: LawCase | null;
  environment: LawEnvironment;
  roster: LawRosterFilter | null;
  error: string | null;
  reload: () => void;
  selectCase: (caseId: string) => void;
  setEnvironment: (environment: LawEnvironment) => void;
  createCase: (name: string) => Promise<LawCase>;
  attachBot: (botId: string) => Promise<void>;
  /** Space captured when this shell mounted. Later storage changes do not retarget fetches. */
  spaceId: string | null;
}

const LawShellContext = createContext<LawShellValue | null>(null);

function environmentStorageKey(spaceId: string | null): string {
  return `law-environment:${spaceId ?? ""}`;
}

function readStoredEnvironment(spaceId: string | null): LawEnvironment | null {
  try {
    const value = sessionStorage.getItem(environmentStorageKey(spaceId));
    return value === "general" || value === "cases" ? value : null;
  } catch {
    return null;
  }
}

function writeStoredEnvironment(spaceId: string | null, environment: LawEnvironment) {
  try {
    sessionStorage.setItem(environmentStorageKey(spaceId), environment);
  } catch {
    /* ignore */
  }
}

export function LawProvider({ children }: { children: ReactNode }) {
  const { botId } = useParams();
  const navigate = useNavigate();
  const [spaceId] = useState(selectedSpaceId);
  const [cases, setCases] = useState<LawCase[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);
  const [environmentChoice, setEnvironmentChoice] = useState<LawEnvironment | null>(() =>
    readStoredEnvironment(spaceId),
  );
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/law/cases", {
      credentials: "same-origin",
      headers: withSpaceHeaders(undefined, spaceId),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as { cases: LawCase[] };
      })
      .then((body) => {
        if (!cancelled) {
          setCases(body.cases);
          setError(null);
          setLoaded(true);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "error");
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, tick]);

  const caseForBot = useMemo(
    () => cases.find((item) => item.bots.some((bot) => bot.botId === botId)) ?? null,
    [botId, cases],
  );

  const environment: LawEnvironment =
    environmentChoice ?? (loaded && cases.length > 0 ? "cases" : "general");

  useEffect(() => {
    // A case bot opened while this space was left on general would flip the
    // stored choice. Leave the bot instead, so switching back restores general.
    if (caseForBot && environmentChoice === "general") navigate("/app");
  }, [caseForBot, environmentChoice, navigate]);

  const selected = useMemo(() => {
    if (environment !== "cases" || cases.length === 0) return null;
    return caseForBot ?? cases[0] ?? null;
  }, [caseForBot, cases, environment]);

  const setEnvironment = useCallback(
    (next: LawEnvironment) => {
      setEnvironmentChoice(next);
      writeStoredEnvironment(spaceId, next);
      if (next === "cases") {
        const target = caseForBot ?? cases[0];
        const bot = target?.bots[0];
        if (bot && bot.botId !== botId) navigate(`/app/${bot.botId}`);
        return;
      }
      const allCaseBotIds = new Set(cases.flatMap((item) => item.bots.map((bot) => bot.botId)));
      if (botId && allCaseBotIds.has(botId)) navigate("/app");
    },
    [botId, caseForBot, cases, navigate, spaceId],
  );

  const selectCase = useCallback(
    (caseId: string) => {
      const next = cases.find((item) => item.id === caseId);
      if (!next) return;
      if (environment !== "cases") {
        setEnvironmentChoice("cases");
        writeStoredEnvironment(spaceId, "cases");
      }
      const role = cases.flatMap((item) => item.bots).find((bot) => bot.botId === botId)?.role;
      const bot = next.bots.find((item) => item.role === role) ?? next.bots[0];
      if (bot && bot.botId !== botId) navigate(`/app/${bot.botId}`);
    },
    [botId, cases, environment, navigate, spaceId],
  );

  const createCase = useCallback(
    async (name: string) => {
      const response = await fetch("/api/law/cases", {
        method: "POST",
        credentials: "same-origin",
        headers: withSpaceHeaders({ "content-type": "application/json" }, spaceId),
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { case: LawCase };
      setCases((current) => [...current, body.case]);
      setEnvironmentChoice("cases");
      writeStoredEnvironment(spaceId, "cases");
      const bot = body.case.bots[0];
      if (bot) navigate(`/app/${bot.botId}`);
      reload();
      return body.case;
    },
    [navigate, reload, spaceId],
  );

  const attachBot = useCallback(
    async (newBotId: string) => {
      if (!selected) return;
      const response = await fetch(`/api/law/cases/${selected.id}/bots`, {
        method: "POST",
        credentials: "same-origin",
        headers: withSpaceHeaders({ "content-type": "application/json" }, spaceId),
        body: JSON.stringify({ botId: newBotId }),
      });
      if (!response.ok) throw new Error(String(response.status));
      reload();
    },
    [reload, selected, spaceId],
  );

  const roster = useMemo<LawRosterFilter>(() => {
    if (!loaded) {
      return { environment, caseBotIds: [], allCaseBotIds: [], loading: true };
    }
    return {
      environment,
      caseBotIds: selected?.bots.map((bot) => bot.botId) ?? [],
      allCaseBotIds: cases.flatMap((item) => item.bots.map((bot) => bot.botId)),
    };
  }, [cases, environment, loaded, selected]);

  const value = useMemo(
    () => ({
      cases,
      selected,
      environment,
      roster,
      error,
      reload,
      selectCase,
      setEnvironment,
      createCase,
      attachBot,
      spaceId,
    }),
    [
      attachBot,
      cases,
      createCase,
      environment,
      error,
      reload,
      roster,
      selectCase,
      selected,
      setEnvironment,
      spaceId,
    ],
  );
  return <LawShellContext.Provider value={value}>{children}</LawShellContext.Provider>;
}

export function useLawShell(): LawShellValue {
  const value = useContext(LawShellContext);
  if (!value) throw new Error("LawProvider is missing");
  return value;
}

/**
 * Width of the environment rail. Kept in this stylesheet because the web app's
 * Tailwind scan does not include this package, so a utility written only here
 * is never generated.
 */
const LAW_CHROME_STYLE = `
.law-chrome-spacer,.law-chrome-rail{width:3rem}
.law-chrome-frame{contain:paint}
@media (max-width:767px){
  .law-chrome-spacer,.law-chrome-rail{display:none}
}
`;

/** Frame that holds the core sidebar in the space to the right of the environment rail. */
export function LawChromeFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
      <style>{LAW_CHROME_STYLE}</style>
      <div className="law-chrome-spacer shrink-0" aria-hidden="true" />
      <LawEnvironmentRail />
      <div className="law-chrome-frame flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}

export function LawEnvironmentRail() {
  const { environment, setEnvironment } = useLawShell();
  return (
    <aside
      data-testid="law-environment-rail"
      className="law-chrome-rail fixed inset-y-0 start-0 z-20 flex flex-col items-center gap-2 border-e border-sidebar-border bg-sidebar py-3"
    >
      <button
        type="button"
        data-testid="law-env-general"
        aria-label="General Stirrup"
        aria-pressed={environment === "general"}
        onClick={() => setEnvironment("general")}
        className={`flex size-9 items-center justify-center rounded-md ${
          environment === "general"
            ? "bg-sidebar-accent text-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent"
        }`}
      >
        <Scale size={18} strokeWidth={1.7} aria-hidden="true" />
      </button>
      <button
        type="button"
        data-testid="law-env-cases"
        aria-label="Cases"
        aria-pressed={environment === "cases"}
        onClick={() => setEnvironment("cases")}
        className={`flex size-9 items-center justify-center rounded-md ${
          environment === "cases"
            ? "bg-sidebar-accent text-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent"
        }`}
      >
        <Briefcase size={18} strokeWidth={1.7} aria-hidden="true" />
      </button>
    </aside>
  );
}

export function LawCaseTabs() {
  const { cases, selected, error, reload, selectCase, createCase, environment } = useLawShell();
  const sidebar = useSidebar();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  if (!sidebar.isMobile && sidebar.state === "collapsed") return null;
  if (environment !== "cases") return null;
  if (error && cases.length === 0) {
    return (
      <button type="button" className="mx-2.5 mt-3 text-body-sm underline" onClick={reload}>
        Retry
      </button>
    );
  }
  return (
    <div data-testid="law-case-tabs" className="flex gap-1 overflow-x-auto px-2.5 pt-3 pb-1">
      {cases.map((item) => {
        const open = item.id === selected?.id;
        return (
          <button
            key={item.id}
            type="button"
            data-testid={`law-case-tab-${item.slug}`}
            aria-pressed={open}
            onClick={() => selectCase(item.id)}
            className={`shrink-0 rounded-full px-3 py-1 text-body-sm ${
              open
                ? "bg-sidebar-accent text-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent"
            }`}
          >
            {item.name.replace("Commonwealth v. ", "")}
          </button>
        );
      })}
      {creating ? (
        <form
          className="flex shrink-0 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const name = draft.trim();
            if (!name || busy) return;
            setBusy(true);
            void createCase(name)
              .then(() => {
                setDraft("");
                setCreating(false);
              })
              .finally(() => setBusy(false));
          }}
        >
          <input
            data-testid="law-case-name-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Case name"
            aria-label="Case name"
            className="w-28 rounded-full border border-border bg-card px-2 py-1 text-body-sm outline-none"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            className="rounded-full bg-sidebar-accent px-2 py-1 text-body-sm"
          >
            Add
          </button>
        </form>
      ) : (
        <button
          type="button"
          data-testid="law-case-add"
          aria-label="Add case"
          onClick={() => setCreating(true)}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        >
          <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function LawCaseColumn() {
  const { selected, error, reload, environment, spaceId } = useLawShell();
  const [documents, setDocuments] = useState<LawFileDoc[]>([]);
  const [docError, setDocError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<LawFileDoc | null>(null);
  const [editor, setEditor] = useState<LawFileDoc | null>(null);
  const caseId = selected?.id ?? null;

  useEffect(() => {
    if (!caseId || environment !== "cases") return;
    let cancelled = false;
    const load = () => {
      void fetch(`/api/law/cases/${caseId}/documents`, {
        credentials: "same-origin",
        headers: withSpaceHeaders(undefined, spaceId),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(String(response.status));
          return (await response.json()) as { documents: LawFileDoc[] };
        })
        .then((body) => {
          if (!cancelled) {
            setDocuments(body.documents);
            setDocError(null);
          }
        })
        .catch((caught: unknown) => {
          if (!cancelled) setDocError(caught instanceof Error ? caught.message : "error");
        });
    };
    load();
    const timer = window.setInterval(load, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [caseId, environment, spaceId]);

  if (environment !== "cases" || !selected) return null;

  const heads = latestLawDocuments(documents);
  const library = heads.filter((doc) => doc.kind === "library");
  const review = heads.filter((doc) => doc.kind === "review");

  async function saveVersion(body: string) {
    if (!editor || !caseId) return;
    const response = await fetch(`/api/law/cases/${caseId}/documents/${editor.id}/versions`, {
      method: "POST",
      credentials: "same-origin",
      headers: withSpaceHeaders({ "content-type": "application/json" }, spaceId),
      body: JSON.stringify({ body }),
    });
    if (!response.ok) throw new Error(String(response.status));
    const payload = (await response.json()) as { document: LawFileDoc };
    setDocuments((current) => [...current, payload.document]);
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
          title="Library"
          testId="law-library"
          docs={library}
          onOpen={(doc) => setViewer(doc)}
        />
        <LawPanel
          title="Documents for review"
          testId="law-review"
          docs={review}
          onOpen={(doc) => {
            if (isEditableLawFile(doc.filename)) setEditor(doc);
            else setViewer(doc);
          }}
          editable
        />
        <section
          data-testid="law-something-else"
          className="flex min-h-0 flex-1 flex-col border-t border-border p-3"
        >
          <SectionHeading as="h2" variant="label">
            Something else
          </SectionHeading>
        </section>
        {error || docError ? (
          <button
            type="button"
            className="border-t border-border px-3 py-2 text-start text-body-sm underline"
            onClick={reload}
          >
            Retry
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
                  setEditor(viewer);
                  setViewer(null);
                }
              : undefined
          }
        />
      ) : null}
      {editor ? (
        <LawDocumentEditor doc={editor} onClose={() => setEditor(null)} onSave={saveVersion} />
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
