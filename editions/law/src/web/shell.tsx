// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { t } from "@lingui/core/macro";
import { toast } from "@rakazo/ui-web";
import { Briefcase, Scale } from "lucide-react";
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
import type { DeletedCaseRow } from "./case-actions.js";
import { landInCasesSpace, selectedSpaceId, withSpaceHeaders } from "./lib.js";
import { LawCaseDocuments } from "./library.js";
import type { LawEnvironment, LawRosterFilter } from "./roster.js";

export { LawCaseTabs } from "./case-actions.js";

interface LawBot {
  role: string;
  name: string;
  botId: string;
}

interface LawCase {
  id: string;
  slug: string;
  name: string;
  canDelete?: boolean;
  bots: LawBot[];
}

interface LawShellValue {
  cases: LawCase[];
  selected: LawCase | null;
  environment: LawEnvironment;
  roster: LawRosterFilter | null;
  error: string | null;
  /** Another Space that holds cases when the current organization has none. */
  casesSpaceId: string | null;
  retentionDays: number;
  canViewDeleted: boolean;
  reload: () => void;
  selectCase: (caseId: string) => void;
  setEnvironment: (environment: LawEnvironment) => void;
  createCase: (name: string) => Promise<LawCase>;
  deleteCase: (caseId: string) => Promise<void>;
  restoreCase: (caseId: string) => Promise<void>;
  listDeletedCases: () => Promise<DeletedCaseRow[]>;
  attachBot: (botId: string) => Promise<void>;
  openCasesSpace: () => void;
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
  const [deletedBotIds, setDeletedBotIds] = useState<string[]>([]);
  const [retentionDays, setRetentionDays] = useState(30);
  const [canViewDeleted, setCanViewDeleted] = useState(false);
  const [casesSpaceId, setCasesSpaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);
  const [environmentChoice, setEnvironmentChoice] = useState<LawEnvironment | null>(() =>
    readStoredEnvironment(spaceId),
  );
  const generalBotRef = useRef<string | null>(readStoredGeneralBot(spaceId));
  /** True after General is chosen until the URL names a bot that is not on a case. */
  const pendingGeneral = useRef(false);
  /** True after Cases is chosen, so the case roster stays up if the route bounces. */
  const pendingCases = useRef(false);
  const caseNavAttempts = useRef(0);
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
        return (await response.json()) as {
          cases: LawCase[];
          casesSpaceId?: string;
          deletedBotIds?: string[];
          retentionDays?: number;
          canViewDeleted?: boolean;
        };
      })
      .then((body) => {
        if (cancelled) return;
        setCases(body.cases);
        setDeletedBotIds(body.deletedBotIds ?? []);
        setRetentionDays(
          typeof body.retentionDays === "number" && body.retentionDays >= 0
            ? body.retentionDays
            : 30,
        );
        setCanViewDeleted(Boolean(body.canViewDeleted));
        setCasesSpaceId(
          body.cases.length === 0 && body.casesSpaceId && body.casesSpaceId !== spaceId
            ? body.casesSpaceId
            : null,
        );
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
  const environment: LawEnvironment = pendingCases.current
    ? "cases"
    : (pendingGeneral.current && caseForBot) || (botId && !loaded)
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
    if (!environmentFromUrl || pendingGeneral.current || pendingCases.current) return;
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
    if (!pendingCases.current || !loaded || caseForBot || caseNavAttempts.current >= 2) return;
    const bot = cases[0]?.bots[0];
    if (!bot || bot.botId === botId) return;
    caseNavAttempts.current += 1;
    navigate(`/app/${bot.botId}`);
  }, [botId, caseForBot, cases, loaded, navigate]);

  useEffect(() => {
    if (!loaded || environment !== "cases" || caseForBot || pendingGeneral.current) return;
    if (pendingCases.current) return;
    const bot = cases[0]?.bots[0];
    if (bot && bot.botId !== botId) navigate(`/app/${bot.botId}`);
  }, [botId, caseForBot, cases, environment, loaded, navigate]);

  const selected = environment === "cases" ? (caseForBot ?? cases[0] ?? null) : null;

  const openCasesSpace = useCallback(() => {
    if (casesSpaceId) landInCasesSpace(casesSpaceId);
  }, [casesSpaceId]);

  const setEnvironment = useCallback(
    (next: LawEnvironment) => {
      setEnvironmentChoice(next);
      writeStoredEnvironment(spaceId, next);
      if (next === "general") {
        pendingCases.current = false;
        pendingGeneral.current = true;
        if (!(botId && caseBotIds.has(botId))) return;
        const target = generalBotRef.current ?? readStoredGeneralBot(spaceId);
        navigate(target && !caseBotIds.has(target) ? `/app/${target}` : "/app");
        return;
      }
      if (cases.length === 0 && casesSpaceId) {
        landInCasesSpace(casesSpaceId);
        return;
      }
      pendingGeneral.current = false;
      pendingCases.current = true;
      caseNavAttempts.current = 0;
      const target = caseForBot ?? cases[0];
      const bot = target?.bots[0];
      if (bot && bot.botId !== botId) {
        caseNavAttempts.current = 1;
        navigate(`/app/${bot.botId}`);
      }
    },
    [botId, caseBotIds, caseForBot, cases, casesSpaceId, navigate, spaceId],
  );

  const selectCase = useCallback(
    (caseId: string) => {
      const next = cases.find((item) => item.id === caseId);
      if (!next) return;
      pendingGeneral.current = false;
      pendingCases.current = true;
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
      pendingCases.current = false;
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

  const deleteCase = useCallback(
    async (caseId: string) => {
      const index = cases.findIndex((item) => item.id === caseId);
      const removed = index >= 0 ? cases[index] : undefined;
      const response = await fetch(`/api/law/cases/${caseId}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: withSpaceHeaders(undefined, spaceId),
      });
      if (!response.ok) throw new Error(String(response.status));
      const nextCases = cases.filter((item) => item.id !== caseId);
      const nextDeletedBotIds = [
        ...new Set([...deletedBotIds, ...(removed?.bots.map((bot) => bot.botId) ?? [])]),
      ];
      setCases(nextCases);
      setDeletedBotIds(nextDeletedBotIds);
      toast(t`Case deleted`);
      const next = nextCases[index] ?? nextCases[index - 1] ?? null;
      if (next) {
        pendingGeneral.current = false;
        pendingCases.current = true;
        // Skip the Cases bounce that would open cases[0] while the URL still names the deleted bot.
        caseNavAttempts.current = 2;
        const role = removed?.bots.find((bot) => bot.botId === botId)?.role;
        const bot = next.bots.find((item) => item.role === role) ?? next.bots[0];
        if (bot && bot.botId !== botId) navigate(`/app/${bot.botId}`);
        return;
      }
      pendingCases.current = false;
      pendingGeneral.current = true;
      setEnvironmentChoice("general");
      writeStoredEnvironment(spaceId, "general");
      const target = generalBotRef.current ?? readStoredGeneralBot(spaceId);
      const hidden = new Set(nextDeletedBotIds);
      navigate(target && !hidden.has(target) ? `/app/${target}` : "/app");
    },
    [botId, cases, deletedBotIds, navigate, spaceId],
  );

  const restoreCase = useCallback(
    async (caseId: string) => {
      const response = await fetch(`/api/law/cases/${caseId}/restore`, {
        method: "POST",
        credentials: "same-origin",
        headers: withSpaceHeaders(undefined, spaceId),
      });
      if (!response.ok) throw new Error(String(response.status));
      reload();
    },
    [reload, spaceId],
  );

  const listDeletedCases = useCallback(async () => {
    const response = await fetch("/api/law/cases?deleted=1", {
      credentials: "same-origin",
      headers: withSpaceHeaders(undefined, spaceId),
    });
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as { cases: DeletedCaseRow[] };
    return body.cases;
  }, [spaceId]);

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
      allCaseBotIds: [
        ...new Set([
          ...cases.flatMap((item) => item.bots.map((bot) => bot.botId)),
          ...deletedBotIds,
        ]),
      ],
    };
  }, [cases, deletedBotIds, environment, loaded, selected]);

  const value = useMemo(
    () => ({
      cases,
      selected,
      environment,
      roster,
      error,
      casesSpaceId,
      retentionDays,
      canViewDeleted,
      reload,
      selectCase,
      setEnvironment,
      createCase,
      deleteCase,
      restoreCase,
      listDeletedCases,
      attachBot,
      openCasesSpace,
      spaceId,
      noteSidebarBotIds,
    }),
    [
      attachBot,
      canViewDeleted,
      cases,
      casesSpaceId,
      createCase,
      deleteCase,
      environment,
      error,
      listDeletedCases,
      noteSidebarBotIds,
      openCasesSpace,
      reload,
      restoreCase,
      retentionDays,
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
/**
 * Spacer reserves the rail's width in flow. `contain:paint` makes the fixed
 * sidebar position relative to this frame (already beside the rail), so the
 * container stays at left:0 — do not add another 3rem offset here.
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

/** Focus ring that meets 3:1 against sidebar and accent fills (ring-ring/50 does not). */
const LAW_FOCUS =
  "focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-foreground/50 focus-visible:outline-none";

/** Selected control: fill alone is ~1.2:1; inset ring-foreground/50 reaches 3:1. */
const LAW_SELECTED =
  "bg-sidebar-accent font-medium text-foreground ring-2 ring-inset ring-foreground/50";

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
        aria-label={t`General Stirrup`}
        aria-pressed={environment === "general"}
        onClick={() => setEnvironment("general")}
        className={`flex size-9 items-center justify-center rounded-md ${LAW_FOCUS} ${
          environment === "general" ? LAW_SELECTED : "text-muted-foreground hover:bg-sidebar-accent"
        }`}
      >
        <Scale size={18} strokeWidth={1.7} aria-hidden="true" />
      </button>
      <button
        type="button"
        data-testid="law-env-cases"
        aria-label={t`Cases`}
        aria-pressed={environment === "cases"}
        onClick={() => setEnvironment("cases")}
        className={`flex size-9 items-center justify-center rounded-md ${LAW_FOCUS} ${
          environment === "cases" ? LAW_SELECTED : "text-muted-foreground hover:bg-sidebar-accent"
        }`}
      >
        <Briefcase size={18} strokeWidth={1.7} aria-hidden="true" />
      </button>
    </aside>
  );
}

export function LawCaseColumn() {
  const { botId } = useParams();
  const { selected, error, reload, environment, spaceId } = useLawShell();
  const urlIsSelected = selected?.bots.some((bot) => bot.botId === botId) ?? false;
  if (environment !== "cases" || !selected || !urlIsSelected) return null;
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
