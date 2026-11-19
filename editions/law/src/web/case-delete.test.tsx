// @vitest-environment jsdom

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { SidebarProvider } from "@rakazo/ui-web/components/ui/sidebar";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caseNameMatches, deleteCaseDialogBody } from "./case-actions.js";
import { applyLawRoster } from "./roster.js";
import { LawCaseColumn, LawCaseTabs, LawProvider, useLawShell } from "./shell.js";

const CASE_ROLES = ["manager", "documents", "transcripts", "generator"] as const;

function caseWithRoles(
  id: string,
  slug: string,
  name: string,
  botPrefix: string,
  canDelete = true,
) {
  return {
    id,
    slug,
    name,
    canDelete,
    bots: CASE_ROLES.map((role) => ({
      role,
      name: `${slug} ${role}`,
      botId: `${botPrefix}-${role}`,
    })),
  };
}

const SYNTHETIC_CASES = {
  cases: [
    caseWithRoles("case-ruiz", "ruiz", "Commonwealth v. Ruiz", "bot-ruiz"),
    caseWithRoles("case-ward", "ward", "Commonwealth v. Ward", "bot-ward"),
    caseWithRoles("case-nunez", "nunez", "Commonwealth v. Nunez", "bot-nunez"),
  ],
  deletedBotIds: [] as string[],
  retentionDays: 30,
  canViewDeleted: true,
};

function RouteMark() {
  const location = useLocation();
  return createElement("div", { "data-testid": "route", "data-path": location.pathname });
}

function RosterProbe() {
  const { roster } = useLawShell();
  const groups = [
    {
      key: "space",
      title: "Space",
      bots: [
        { chat: { id: "bot-ward-manager" }, label: "Ward" },
        { chat: { id: "general-bot" }, label: "General" },
      ],
    },
  ];
  const ids = applyLawRoster(groups, roster).flatMap((group) =>
    group.bots.map((bot) => bot.chat.id),
  );
  return createElement("div", {
    "data-testid": "roster-ids",
    "data-ids": ids.join(" "),
  });
}

function DocFetchProbe({ caseId }: { caseId: string }) {
  const { selected } = useLawShell();
  useEffect(() => {
    if (!selected || selected.id !== caseId) return;
    void fetch(`/api/law/cases/${caseId}/documents`, { credentials: "same-origin" });
  }, [caseId, selected]);
  return null;
}

function DeleteProbe({ caseId }: { caseId: string }) {
  const { deleteCase } = useLawShell();
  return createElement("button", {
    type: "button",
    "data-testid": "law-case-delete-probe",
    onClick: () => {
      void deleteCase(caseId);
    },
  });
}

async function mountShell(
  children: ReturnType<typeof createElement>,
  initialPath = "/app/bot-ward-manager",
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [initialPath] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/app/:botId?",
            element: createElement(LawProvider, null, children),
          }),
        ),
      ),
    );
  });
  return { container, root };
}

describe("case delete confirmation helpers", () => {
  it("matches the typed name case-insensitively after trim", () => {
    expect(caseNameMatches("  commonwealth v. ward ", "Commonwealth v. Ward")).toBe(true);
    expect(caseNameMatches("Commonwealth v. Ruiz", "Commonwealth v. Ward")).toBe(false);
  });

  it("describes retention days and the never-purge wording", () => {
    expect(deleteCaseDialogBody("Commonwealth v. Ward", 30)).toContain("30 days");
    expect(deleteCaseDialogBody("Commonwealth v. Ward", 0)).toContain(
      "kept until an administrator removes them",
    );
  });
});

describe("case delete UI", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    if (typeof window.matchMedia !== "function") {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: (query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() {
            return false;
          },
        }),
      });
    }
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/law/cases") {
          return new Response(JSON.stringify(SYNTHETIC_CASES), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.startsWith("/api/law/cases/") && url.endsWith("/documents")) {
          return new Response(JSON.stringify({ documents: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (init?.method === "DELETE" && url === "/api/law/cases/case-ward") {
          return new Response(JSON.stringify({ id: "case-ward", purgeAfter: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (init?.method === "DELETE" && url === "/api/law/cases/case-nunez") {
          return new Response(JSON.stringify({ id: "case-nunez", purgeAfter: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("keeps Delete case disabled until the typed name matches", async () => {
    const { DeleteCaseDialog } = await import("./case-actions.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(DeleteCaseDialog, {
          open: true,
          name: "Commonwealth v. Ward",
          retentionDays: 30,
          busy: false,
          onOpenChange: () => {},
          onConfirm: () => {},
        }),
      );
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="law-case-delete-submit"]')).not.toBeNull();
    });
    const submit = document.querySelector(
      '[data-testid="law-case-delete-submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const input = document.querySelector(
      '[data-testid="law-case-delete-confirm"]',
    ) as HTMLInputElement;
    await act(async () => {
      const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      native?.call(input, "commonwealth v. ward");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(
        (document.querySelector('[data-testid="law-case-delete-submit"]') as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    await act(async () => {
      root.unmount();
    });
  });

  it("lands on the next case after delete and stops document fetches for the deleted case", async () => {
    const fetches: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetches.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/api/law/cases") {
          return new Response(JSON.stringify(SYNTHETIC_CASES), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.startsWith("/api/law/cases/") && url.endsWith("/documents")) {
          return new Response(JSON.stringify({ documents: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (init?.method === "DELETE" && url === "/api/law/cases/case-ward") {
          return new Response(JSON.stringify({ id: "case-ward", purgeAfter: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const { container, root } = await mountShell(
      createElement(
        SidebarProvider,
        null,
        createElement(RouteMark),
        createElement(LawCaseTabs),
        createElement(LawCaseColumn),
        createElement(DocFetchProbe, { caseId: "case-ward" }),
        createElement(DeleteProbe, { caseId: "case-ward" }),
      ),
      "/app/bot-ward-manager",
    );
    await act(async () => {});
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="law-case-tab-ward"]')).not.toBeNull();
    });
    const beforeDeleteDocs = fetches.filter((entry) =>
      entry.includes("/api/law/cases/case-ward/documents"),
    ).length;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="law-case-delete-probe"]')?.click();
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="law-case-tab-ward"]')).toBeNull();
      expect(container.querySelector('[data-testid="route"]')?.getAttribute("data-path")).toBe(
        "/app/bot-nunez-manager",
      );
    });
    const afterDeleteDocs = fetches.filter((entry) =>
      entry.includes("/api/law/cases/case-ward/documents"),
    ).length;
    expect(afterDeleteDocs).toBe(beforeDeleteDocs);
    await act(async () => {
      root.unmount();
    });
  });

  it("lands in General when the last case is deleted and keeps its bots out of General", async () => {
    const onlyCase = {
      cases: [caseWithRoles("case-ward", "ward", "Commonwealth v. Ward", "bot-ward")],
      deletedBotIds: [],
      retentionDays: 30,
      canViewDeleted: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/law/cases") {
          return new Response(JSON.stringify(onlyCase), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (init?.method === "DELETE" && url === "/api/law/cases/case-ward") {
          return new Response(JSON.stringify({ id: "case-ward", purgeAfter: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ documents: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    sessionStorage.setItem("law-general-bot:", "general-bot");
    const { container, root } = await mountShell(
      createElement(
        SidebarProvider,
        null,
        createElement(RouteMark),
        createElement(LawCaseTabs),
        createElement(RosterProbe),
        createElement(DeleteProbe, { caseId: "case-ward" }),
      ),
      "/app/bot-ward-manager",
    );
    await act(async () => {});
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="law-case-tab-ward"]')).not.toBeNull();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="law-case-delete-probe"]')?.click();
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="route"]')?.getAttribute("data-path")).toBe(
        "/app/general-bot",
      );
      expect(container.querySelector('[data-testid="roster-ids"]')?.getAttribute("data-ids")).toBe(
        "general-bot",
      );
    });
    await act(async () => {
      root.unmount();
    });
  });
});
