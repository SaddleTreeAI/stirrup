// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { t } from "@lingui/core/macro";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import { useSidebar } from "@rakazo/ui-web/components/ui/sidebar";
import { Ellipsis, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useLawShell } from "./shell.js";

const LAW_FOCUS =
  "focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-foreground/50 focus-visible:outline-none";

export function caseNameMatches(typed: string, name: string): boolean {
  return typed.trim().toLowerCase() === name.trim().toLowerCase();
}

export function deleteCaseDialogBody(name: string, retentionDays: number): string {
  if (retentionDays <= 0) {
    return t`${name} and its Library, search, and bot conversations disappear for everyone on the case. They are kept until an administrator removes them; an administrator can restore the case until then.`;
  }
  return t`${name} and its Library, search, and bot conversations disappear for everyone on the case. They are kept for ${retentionDays} days and then permanently deleted; an administrator can restore the case until then.`;
}

export function CaseTabActions({
  canDelete,
  children,
  onDelete,
}: {
  canDelete: boolean;
  children: ReactNode;
  onDelete: () => void;
}) {
  if (!canDelete) return <>{children}</>;
  return (
    <ContextMenu>
      <ContextMenuTrigger className="group/case-tab relative inline-flex items-center">
        {children}
        <button
          type="button"
          data-testid="law-case-tab-actions"
          aria-label={t`Case actions`}
          className={`absolute end-0 top-1/2 z-10 flex size-5 -translate-y-1/2 items-center justify-center rounded-full bg-sidebar text-muted-foreground opacity-0 group-hover/case-tab:opacity-100 group-focus-within/case-tab:opacity-100 hover:bg-sidebar-accent hover:text-foreground ${LAW_FOCUS}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onDelete();
          }}
        >
          <Ellipsis size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={t`Case actions`} className="w-[180px]">
        <ContextMenuItem
          variant="destructive"
          data-testid="law-case-delete-menu"
          onClick={onDelete}
        >
          <Trash2 />
          {t`Delete case...`}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function DeleteCaseDialog({
  open,
  name,
  retentionDays,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  name: string;
  retentionDays: number;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const matched = caseNameMatches(typed, name);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped("");
        onOpenChange(next);
      }}
    >
      <AlertDialogContent data-testid="law-case-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Delete this case?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {deleteCaseDialogBody(name, retentionDays)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="mt-2 block space-y-1.5">
          <label
            htmlFor="law-case-delete-confirm"
            className="text-body-sm text-muted-foreground"
          >{t`Type the case name to confirm`}</label>
          <Input
            id="law-case-delete-confirm"
            data-testid="law-case-delete-confirm"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t`Cancel`}</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            data-testid="law-case-delete-submit"
            disabled={busy || !matched}
            onClick={() => {
              void onConfirm();
            }}
          >
            {t`Delete case`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface DeletedCaseRow {
  id: string;
  slug: string;
  name: string;
  deletedAt: string;
  purgeAfter: string | null;
}

export function RecentlyDeletedDialog({
  open,
  cases,
  busyId,
  onOpenChange,
  onRestore,
}: {
  open: boolean;
  cases: readonly DeletedCaseRow[];
  busyId: string | null;
  onOpenChange: (open: boolean) => void;
  onRestore: (caseId: string) => void | Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="law-recently-deleted-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t`Recently deleted`}</DialogTitle>
          <DialogDescription>{t`Restore a case within the retention window.`}</DialogDescription>
        </DialogHeader>
        {cases.length === 0 ? (
          <p className="text-body-sm text-muted-foreground">{t`No deleted cases`}</p>
        ) : (
          <ul className="max-h-72 space-y-2 overflow-y-auto">
            {cases.map((item) => (
              <li
                key={item.id}
                data-testid={`law-deleted-case-${item.slug}`}
                className="flex items-center justify-between gap-2"
              >
                <span className="min-w-0 truncate text-body-sm">{item.name}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid={`law-restore-case-${item.slug}`}
                  disabled={busyId === item.id}
                  onClick={() => {
                    void onRestore(item.id);
                  }}
                >
                  {t`Restore`}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function openOrganizationMenu() {
  const trigger = document.querySelector<HTMLElement>('[data-testid="organization-menu-trigger"]');
  trigger?.click();
}

/**
 * Case bar layout. Local classes so the strip works even when an edition-only
 * Tailwind utility is missing from the web CSS bundle (W9 scans editions, but
 * keep critical sizing here like .law-chrome-*).
 */
const LAW_CASE_BAR_STYLE = `
.law-case-bar{min-width:0;width:100%}
.law-case-bar-row{display:flex;align-items:center;gap:0.25rem;min-width:0}
.law-case-bar-scroll{flex:1 1 0%;min-width:0;overflow-x:auto;scrollbar-width:thin}
.law-case-bar-scroll::-webkit-scrollbar{height:4px}
.law-case-bar-scroll .group\\/tabs-list{flex-wrap:nowrap}
.law-case-tab{max-width:12rem}
.law-case-tab-label{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
`;

function caseTabLabel(name: string): string {
  return name.replace("Commonwealth v. ", "");
}

/** Case tab strip with delete / restore actions (SidebarLeading). */
export function LawCaseTabs() {
  const {
    cases,
    selected,
    error,
    reload,
    selectCase,
    createCase,
    deleteCase,
    restoreCase,
    listDeletedCases,
    environment,
    casesSpaceId,
    openCasesSpace,
    retentionDays,
    canViewDeleted,
  } = useLawShell();
  const sidebar = useSidebar();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [deletedRows, setDeletedRows] = useState<DeletedCaseRow[]>([]);
  const [restoreBusyId, setRestoreBusyId] = useState<string | null>(null);

  async function openRecentlyDeleted() {
    setRecentOpen(true);
    try {
      setDeletedRows(await listDeletedCases());
    } catch {
      setDeletedRows([]);
    }
  }

  if (!sidebar.isMobile && sidebar.state === "collapsed") return null;
  if (environment !== "cases") return null;
  if (error && cases.length === 0) {
    return (
      <button
        type="button"
        className={`mx-2.5 mt-3 text-body-sm underline ${LAW_FOCUS}`}
        onClick={reload}
      >
        {t`Retry`}
      </button>
    );
  }
  if (cases.length === 0) {
    return (
      <div data-testid="law-cases-empty" className="mx-2.5 mt-3 space-y-2">
        <p className="text-body-sm text-muted-foreground">{t`No cases in this organization`}</p>
        {creating ? (
          <form
            className="flex items-center gap-1"
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
            <Input
              data-testid="law-case-name-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t`Case name`}
              aria-label={t`Case name`}
              className={`h-7 w-28 rounded-full border-foreground/50 bg-card px-2 py-1 text-body-sm placeholder:text-muted-foreground ${LAW_FOCUS}`}
            />
            <Button
              type="submit"
              size="sm"
              disabled={busy || !draft.trim()}
              className={`rounded-full ${LAW_FOCUS}`}
            >
              {t`Add`}
            </Button>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            {casesSpaceId ? (
              <button
                type="button"
                data-testid="law-cases-empty-open"
                onClick={openCasesSpace}
                className={`rounded-md bg-sidebar-accent px-2.5 py-1 text-body-sm text-foreground ${LAW_FOCUS}`}
              >
                {t`Open cases`}
              </button>
            ) : (
              <button
                type="button"
                data-testid="law-cases-empty-create"
                onClick={() => setCreating(true)}
                className={`rounded-md bg-sidebar-accent px-2.5 py-1 text-body-sm text-foreground ${LAW_FOCUS}`}
              >
                {t`Create case`}
              </button>
            )}
            {canViewDeleted ? (
              <button
                type="button"
                data-testid="law-recently-deleted"
                onClick={() => {
                  void openRecentlyDeleted();
                }}
                className={`rounded-md px-2.5 py-1 text-body-sm text-muted-foreground underline-offset-2 hover:underline ${LAW_FOCUS}`}
              >
                {t`Recently deleted`}
              </button>
            ) : null}
            <button
              type="button"
              data-testid="law-cases-empty-switch-org"
              onClick={openOrganizationMenu}
              className={`rounded-md px-2.5 py-1 text-body-sm text-muted-foreground underline-offset-2 hover:underline ${LAW_FOCUS}`}
            >
              {t`Switch organization`}
            </button>
          </div>
        )}
        <RecentlyDeletedDialog
          open={recentOpen}
          cases={deletedRows}
          busyId={restoreBusyId}
          onOpenChange={setRecentOpen}
          onRestore={async (caseId) => {
            setRestoreBusyId(caseId);
            try {
              await restoreCase(caseId);
              setDeletedRows((current) => current.filter((row) => row.id !== caseId));
            } finally {
              setRestoreBusyId(null);
            }
          }}
        />
      </div>
    );
  }
  return (
    <div data-testid="law-case-tabs" className="law-case-bar px-2.5 pt-3 pb-1">
      <style>{LAW_CASE_BAR_STYLE}</style>
      <div className="law-case-bar-row">
        <div className="law-case-bar-scroll" data-testid="law-case-tabs-scroll">
          <Tabs
            value={selected?.id ?? cases[0]?.id ?? ""}
            onValueChange={selectCase}
            className="w-max gap-0"
          >
            <TabsList
              variant="line"
              aria-label={t`Cases`}
              className="h-auto w-max gap-1 rounded-none bg-transparent p-0"
            >
              {cases.map((item) => {
                const label = caseTabLabel(item.name);
                return (
                  <CaseTabActions
                    key={item.id}
                    canDelete={Boolean(item.canDelete)}
                    onDelete={() => setDeleteTarget(item)}
                  >
                    <TabsTrigger
                      value={item.id}
                      title={item.name}
                      data-testid={`law-case-tab-${item.slug}`}
                      className={`law-case-tab h-auto flex-none rounded-full px-3 py-1 pe-6 text-body-sm text-muted-foreground after:hidden ${LAW_FOCUS} data-active:bg-sidebar-accent data-active:font-medium data-active:text-foreground data-active:shadow-none data-active:ring-2 data-active:ring-inset data-active:ring-foreground/50`}
                    >
                      <span className="law-case-tab-label">{label}</span>
                    </TabsTrigger>
                  </CaseTabActions>
                );
              })}
            </TabsList>
          </Tabs>
        </div>
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
            <Input
              data-testid="law-case-name-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t`Case name`}
              aria-label={t`Case name`}
              className={`h-7 w-28 rounded-full border-foreground/50 bg-card px-2 py-1 text-body-sm placeholder:text-muted-foreground ${LAW_FOCUS}`}
            />
            <Button
              type="submit"
              size="sm"
              disabled={busy || !draft.trim()}
              className={`rounded-full ${LAW_FOCUS}`}
            >
              {t`Add`}
            </Button>
          </form>
        ) : (
          <button
            type="button"
            data-testid="law-case-add"
            aria-label={t`Add case`}
            onClick={() => setCreating(true)}
            className={`flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-card px-2.5 py-1 text-body-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground ${LAW_FOCUS}`}
          >
            <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
            {t`Case`}
          </button>
        )}
      </div>
      {canViewDeleted ? (
        <button
          type="button"
          data-testid="law-recently-deleted"
          onClick={() => {
            void openRecentlyDeleted();
          }}
          className={`mt-1 rounded-full px-1 text-body-sm text-muted-foreground underline-offset-2 hover:underline ${LAW_FOCUS}`}
        >
          {t`Recently deleted`}
        </button>
      ) : null}
      <DeleteCaseDialog
        open={Boolean(deleteTarget)}
        name={deleteTarget?.name ?? ""}
        retentionDays={retentionDays}
        busy={deleteBusy}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setDeleteBusy(true);
          try {
            await deleteCase(deleteTarget.id);
            setDeleteTarget(null);
          } finally {
            setDeleteBusy(false);
          }
        }}
      />
      <RecentlyDeletedDialog
        open={recentOpen}
        cases={deletedRows}
        busyId={restoreBusyId}
        onOpenChange={setRecentOpen}
        onRestore={async (caseId) => {
          setRestoreBusyId(caseId);
          try {
            await restoreCase(caseId);
            setDeletedRows((current) => current.filter((row) => row.id !== caseId));
          } finally {
            setRestoreBusyId(null);
          }
        }}
      />
    </div>
  );
}
