// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { SectionHeading } from "@rakazo/ui-web";
import { useSidebar } from "@rakazo/ui-web/components/ui/sidebar";
import { Briefcase, Plus, Scale } from "lucide-react";
import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  /** Remembers a non-case bot seen in the sidebar, so General can open it later. */
  noteSidebarBotIds: (botIds: readonly string[]) => void;
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

function generalBotStorageKey(spaceId: string | null): string {
  return `law-general-bot:${spaceId ?? ""}`;
}

function readStoredGeneralBot(spaceId: string | null): string | null {
  try {
    return sessionStorage.getItem(generalBotStorageKey(spaceId)) || null;
  } catch {
    return null;
  }
}

function writeStoredGeneralBot(spaceId: string | null, botId: string) {
  try {
    sessionStorage.setItem(generalBotStorageKey(spaceId), botId);
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
  const generalBotRef = useRef<string | null>(readStoredGeneralBot(spaceId));
  /** True after General is chosen until the URL names a bot that is not on a case. */
  const pendingGeneral = useRef(false);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void fetch("/api/law/cases", {
      credentials: "same-origin",
      headers: withSpaceHeaders(undefined, spaceId),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as { cases: LawCase[] };
      })
      .then((body) => {
        if (cancelled) return;
        setCases(body.cases);
        setError(null);
        setLoaded(true);
      })
      .catch((caught: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "error");
        setLoaded(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [spaceId, tick]);

  const caseForBot = useMemo(
    () => cases.find((item) => item.bots.some((bot) => bot.botId === botId)) ?? null,
    [botId, cases],
  );
  const caseBotIds = useMemo(
    () => new Set(cases.flatMap((item) => item.bots.map((bot) => bot.botId))),
    [cases],
  );

  // A bot in the URL is the source of truth once the case list can classify it.
  // Until then, show no case. The stored choice applies only to a bare /app.
  const environmentFromUrl: LawEnvironment | null =
    loaded && botId ? (caseForBot ? "cases" : "general") : null;
  const environment: LawEnvironment =
    (pendingGeneral.current && caseForBot) || (botId && !loaded)
      ? "general"
      : (environmentFromUrl ??
        environmentChoice ??
        (loaded && cases.length > 0 ? "cases" : "general"));

  useEffect(() => {
    if (!loaded || !botId || caseForBot) return;
    pendingGeneral.current = false;
    generalBotRef.current = botId;
    writeStoredGeneralBot(spaceId, botId);
  }, [botId, caseForBot, loaded, spaceId]);

  useEffect(() => {
    if (!environmentFromUrl || pendingGeneral.current) return;
    setEnvironmentChoice((current) =>
      current === environmentFromUrl ? current : environmentFromUrl,
    );
    if (readStoredEnvironment(spaceId) !== environmentFromUrl) {
      writeStoredEnvironment(spaceId, environmentFromUrl);
    }
  }, [environmentFromUrl, spaceId]);

  useEffect(() => {
    if (!pendingGeneral.current || !loaded || !caseForBot) return;
    const target = generalBotRef.current ?? readStoredGeneralBot(spaceId);
    if (target && !caseBotIds.has(target)) {
      if (target !== botId) navigate(`/app/${target}`);
      return;
    }
    if (botId) navigate("/app");
  }, [botId, caseBotIds, caseForBot, loaded, navigate, spaceId]);

  useEffect(() => {
    if (!loaded || environment !== "cases" || caseForBot || pendingGeneral.current) return;
    const bot = cases[0]?.bots[0];
    if (bot && bot.botId !== botId) navigate(`/app/${bot.botId}`);
  }, [botId, caseForBot, cases, environment, loaded, navigate]);

  const selected = environment === "cases" && caseForBot ? caseForBot : null;

  const setEnvironment = useCallback(
    (next: LawEnvironment) => {
      setEnvironmentChoice(next);
      writeStoredEnvironment(spaceId, next);
      if (next === "general") {
        pendingGeneral.current = true;
        if (!(botId && caseBotIds.has(botId))) return;
        const target = generalBotRef.current ?? readStoredGeneralBot(spaceId);
        navigate(target && !caseBotIds.has(target) ? `/app/${target}` : "/app");
        return;
      }
      pendingGeneral.current = false;
      const target = caseForBot ?? cases[0];
      const bot = target?.bots[0];
      if (bot && bot.botId !== botId) navigate(`/app/${bot.botId}`);
    },
    [botId, caseBotIds, caseForBot, cases, navigate, spaceId],
  );

  const selectCase = useCallback(
    (caseId: string) => {
      const next = cases.find((item) => item.id === caseId);
      if (!next) return;
      pendingGeneral.current = false;
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
      pendingGeneral.current = false;
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

  const noteSidebarBotIds = useCallback(
    (botIds: readonly string[]) => {
      if (!loaded) return;
      const general = botIds.find((id) => !caseBotIds.has(id));
      if (!general) return;
      generalBotRef.current = general;
      writeStoredGeneralBot(spaceId, general);
    },
    [caseBotIds, loaded, spaceId],
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
      noteSidebarBotIds,
    }),
    [
      attachBot,
      cases,
      createCase,
      environment,
      error,
      noteSidebarBotIds,
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
  if (environment !== "cases" || !selected) return null;
  return (
    <LawCaseDocuments
      key={selected.id}
      caseId={selected.id}
      spaceId={spaceId}
      shellError={error}
      reload={reload}
    />
  );
}

function LawCaseDocuments({
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
            Something else
          </SectionHeading>
        </section>
        {shellError || docError ? (
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
