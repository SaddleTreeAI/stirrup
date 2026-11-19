// @vitest-environment jsdom

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { deferred, flush } from "@rakazo/core/test-async";
import { SidebarProvider } from "@rakazo/ui-web/components/ui/sidebar";
import { act, createElement, useEffect, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyLawRoster } from "./roster.js";
import {
  LawCaseColumn,
  LawCaseTabs,
  LawChromeFrame,
  LawEnvironmentRail,
  LawProvider,
  useLawShell,
} from "./shell.js";

const SYNTHETIC_CASES = {
  cases: [
    {
      id: "case-ruiz",
      slug: "ruiz",
      name: "Fake Case Ruiz",
      bots: [{ role: "paralegal", name: "Fake Ruiz bot", botId: "bot-ruiz" }],
    },
    {
      id: "case-ward",
      slug: "ward",
      name: "Fake Case Ward",
      bots: [{ role: "paralegal", name: "Fake Ward bot", botId: "bot-ward" }],
    },
    {
      id: "case-nunez",
      slug: "nunez",
      name: "Fake Case Nunez",
      bots: [{ role: "paralegal", name: "Fake Nunez bot", botId: "bot-nunez" }],
    },
  ],
};

const SPACE_KEY = "rakazo:space-id";

const SAMPLE_GROUPS = [
  {
    key: "space",
    title: "Space",
    bots: [
      { chat: { id: "bot-ruiz" }, label: "Case" },
      { chat: { id: "general-bot" }, label: "General" },
    ],
  },
];

function RosterProbe() {
  const { roster } = useLawShell();
  const ids = applyLawRoster(SAMPLE_GROUPS, roster).flatMap((group) =>
    group.bots.map((bot) => bot.chat.id),
  );
  return createElement("div", {
    "data-testid": "roster-ids",
    "data-loading": roster?.loading ? "true" : "false",
    "data-ids": ids.join(" "),
  });
}

function FlipSpaceAfterLayout() {
  useLayoutEffect(() => {
    localStorage.setItem(SPACE_KEY, "space-other");
  }, []);
  return null;
}

async function mountShell(
  children: ReturnType<typeof createElement> = createElement(
    SidebarProvider,
    null,
    createElement(LawEnvironmentRail),
    createElement(LawCaseTabs),
  ),
  initialPath = "/app",
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

function lawFile(id: string, title: string, kind = "library", filename = `${id}.pdf`) {
  return { id, title, filename, kind, body: title, version: 1, rootId: id };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function columnTitles(container: HTMLElement) {
  return [...container.querySelectorAll("[data-testid^=law-file-card-]")].map(
    (node) => node.querySelector("button span")?.textContent ?? "",
  );
}

function RouteMark() {
  const location = useLocation();
  return createElement("div", { "data-testid": "route", "data-path": location.pathname });
}

/** Sends the first landing on a case bot back to General, once. */
function StealCaseOnce() {
  const location = useLocation();
  const navigate = useNavigate();
  const stole = useRef(false);
  useEffect(() => {
    if (stole.current || location.pathname !== "/app/bot-ruiz") return;
    stole.current = true;
    navigate("/app/general-bot", { replace: true });
  }, [location.pathname, navigate]);
  return createElement("div", { "data-testid": "route", "data-path": location.pathname });
}

/** Stands in for core sending a bare /app to the first unfiltered bot, which is a case bot. */
function StealBareApp() {
  const location = useLocation();
  const navigate = useNavigate();
  const stole = useRef(false);
  useEffect(() => {
    if (location.pathname !== "/app" || stole.current) return;
    stole.current = true;
    navigate("/app/bot-ruiz", { replace: true });
  }, [location.pathname, navigate]);
  return createElement("div", {
    "data-testid": "route",
    "data-path": location.pathname,
  });
}

describe("law shell chrome", () => {
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
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/law/cases") {
          return new Response(JSON.stringify(SYNTHETIC_CASES), {
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

  it("renders the environment rail and case tabs for synthetic cases", async () => {
    const { container, root } = await mountShell();
    await act(async () => {});
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="law-environment-rail"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="law-case-tabs"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="law-case-tab-ruiz"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="law-case-tab-ward"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="law-case-tab-nunez"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="law-env-general"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="law-env-cases"]')).not.toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the stored environment on its space and opens an empty space in general", async () => {
    sessionStorage.setItem("law-environment:space-a", "general");
    localStorage.setItem(SPACE_KEY, "space-a");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const space = new Headers(init?.headers).get("x-rakazo-space-id");
        const body = space === "space-b" ? { cases: [] } : SYNTHETIC_CASES;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const first = await mountShell();
    await act(async () => {});
    await vi.waitFor(() => {
      expect(first.container.querySelector('[data-testid="law-case-tabs"]')).toBeNull();
      expect(
        first.container
          .querySelector('[data-testid="law-env-general"]')
          ?.getAttribute("aria-pressed"),
      ).toBe("true");
    });
    await act(async () => {
      first.root.unmount();
    });

    localStorage.setItem(SPACE_KEY, "space-b");
    const second = await mountShell();
    await act(async () => {});
    await vi.waitFor(() => {
      expect(second.container.querySelector('[data-testid="law-case-tabs"]')).toBeNull();
      expect(
        second.container
          .querySelector('[data-testid="law-env-general"]')
          ?.getAttribute("aria-pressed"),
      ).toBe("true");
    });
    expect(sessionStorage.getItem("law-environment:space-a")).toBe("general");
    await act(async () => {
      second.root.unmount();
    });
  });

  it("fetches cases with the space captured at mount", async () => {
    localStorage.setItem(SPACE_KEY, "space-mount");
    const seen: Array<string | null> = [];
    const pending = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("x-rakazo-space-id"));
        return pending.promise;
      }),
    );
    const { root } = await mountShell(
      createElement(
        SidebarProvider,
        null,
        createElement(FlipSpaceAfterLayout),
        createElement(LawCaseTabs),
      ),
    );
    await act(async () => {});
    expect(localStorage.getItem(SPACE_KEY)).toBe("space-other");
    expect(seen).toEqual(["space-mount"]);
    pending.resolve(
      new Response(JSON.stringify(SYNTHETIC_CASES), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await act(async () => {});
    await act(async () => {
      root.unmount();
    });
  });

  it("does not show the unfiltered roster before the case list arrives", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pending.promise),
    );
    const { container, root } = await mountShell(
      createElement(SidebarProvider, null, createElement(RosterProbe)),
    );
    await act(async () => {});
    const probe = container.querySelector('[data-testid="roster-ids"]');
    expect(probe?.getAttribute("data-loading")).toBe("true");
    expect(probe?.getAttribute("data-ids")).toBe("");
    pending.resolve(
      new Response(JSON.stringify({ cases: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await act(async () => {});
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="roster-ids"]')?.getAttribute("data-loading"),
      ).toBe("false");
    });
    await act(async () => {
      root.unmount();
    });
  });

  it("hides case tabs while the desktop sidebar is collapsed", async () => {
    const { container, root } = await mountShell(
      createElement(
        SidebarProvider,
        { open: false },
        createElement(LawEnvironmentRail),
        createElement(LawCaseTabs),
      ),
    );
    await act(async () => {});
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="law-environment-rail"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="law-case-tabs"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  it("places the rail beside a containing block with no left offset utility", async () => {
    const { container, root } = await mountShell(
      createElement(LawChromeFrame, null, createElement("div")),
    );
    await act(async () => {});
    expect(container.querySelector("aside[data-testid=law-environment-rail]")).not.toBeNull();
    const frame = container.querySelector(".law-chrome-frame");
    expect(frame).not.toBeNull();
    expect(frame?.className ?? "").not.toContain("left-12");
    expect(container.querySelector(".law-chrome-spacer")).not.toBeNull();
    expect(container.querySelector(".law-chrome-rail")).not.toBeNull();
    const css = container.querySelector("style")?.textContent ?? "";
    expect(css).toContain('[data-slot="sidebar-container"][data-side="left"]{left:3rem}');
    await act(async () => {
      root.unmount();
    });
  });

  it("opens the case workers when Cases is clicked, even if the route bounces once", async () => {
    const { container, root } = await mountShell(
      createElement(
        SidebarProvider,
        null,
        createElement(StealCaseOnce),
        createElement(RosterProbe),
        createElement(LawEnvironmentRail),
        createElement(LawCaseTabs),
      ),
      "/app/general-bot",
    );
    await act(async () => {});
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="roster-ids"]')?.getAttribute("data-loading"),
      ).toBe("false");
    });
    expect(container.querySelector('[data-testid="roster-ids"]')?.getAttribute("data-ids")).toBe(
      "general-bot",
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="law-env-cases"]')?.click();
      await flush();
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="roster-ids"]')?.getAttribute("data-ids")).toBe(
        "bot-ruiz",
      );
    });
    expect(container.querySelector('[data-testid="route"]')?.getAttribute("data-path")).toBe(
      "/app/bot-ruiz",
    );
    expect(
      container.querySelector('[data-testid="law-case-tab-ruiz"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    await act(async () => {
      root.unmount();
    });
  });

  it("renders only the newer case when an older document response arrives later", async () => {
    const ruizDocs = deferred<Response>();
    const wardDocs = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/law/cases") return jsonResponse(SYNTHETIC_CASES);
        if (url === "/api/law/cases/case-ruiz/documents") return ruizDocs.promise;
        if (url === "/api/law/cases/case-ward/documents") return wardDocs.promise;
        return new Response("not found", { status: 404 });
      }),
    );
    const { container, root } = await mountShell(
      createElement(
        SidebarProvider,
        null,
        createElement(LawEnvironmentRail),
        createElement(LawCaseTabs),
        createElement(LawCaseColumn),
      ),
      "/app/bot-ruiz",
    );
    await act(async () => {});
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="law-case-tab-ward"]')).not.toBeNull();
    });
    const seen = new Set<string>();
    const note = () => {
      for (const title of columnTitles(container)) seen.add(title);
    };
    note();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="law-case-tab-ward"]')?.click();
    });
    note();
    wardDocs.resolve(jsonResponse({ documents: [lawFile("ward-doc", "Ward Memo")] }));
    await act(async () => {
      await flush();
    });
    note();
    ruizDocs.resolve(jsonResponse({ documents: [lawFile("ruiz-doc", "Ruiz Memo")] }));
    await act(async () => {
      await flush();
    });
    note();
    expect([...seen]).toEqual(["Ward Memo"]);
    expect(columnTitles(container)).toEqual(["Ward Memo"]);
    await act(async () => {
      root.unmount();
    });
  });

  it("clears the aside as soon as the case changes, before the next documents arrive", async () => {
    const ruizDocs = deferred<Response>();
    const wardDocs = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/law/cases") return jsonResponse(SYNTHETIC_CASES);
        if (url === "/api/law/cases/case-ruiz/documents") return ruizDocs.promise;
        if (url === "/api/law/cases/case-ward/documents") return wardDocs.promise;
        return new Response("not found", { status: 404 });
      }),
    );
    const { container, root } = await mountShell(
      createElement(
        SidebarProvider,
        null,
        createElement(LawCaseTabs),
        createElement(LawCaseColumn),
      ),
      "/app/bot-ruiz",
    );
    await act(async () => {});
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="law-column"]')).not.toBeNull();
    });
    ruizDocs.resolve(jsonResponse({ documents: [lawFile("ruiz-doc", "Ruiz Memo")] }));
    await act(async () => {
      await flush();
    });
    expect(columnTitles(container)).toEqual(["Ruiz Memo"]);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="law-case-tab-ward"]')?.click();
    });
    expect(columnTitles(container)).toEqual([]);
    await act(async () => {
      root.unmount();
    });
  });

  it("keeps General selected when a bare /app route resolves to a case bot", async () => {
    sessionStorage.setItem("law-general-bot:", "general-bot");
    const { container, root } = await mountShell(
      createElement(
        SidebarProvider,
        null,
        createElement(StealBareApp),
        createElement(LawEnvironmentRail),
        createElement(LawCaseTabs),
        createElement(LawCaseColumn),
      ),
      "/app/bot-ruiz",
    );
    await act(async () => {});
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="law-case-tab-ruiz"]')).not.toBeNull();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="law-env-general"]')?.click();
    });
    await act(async () => {
      await flush();
    });
    expect(
      container.querySelector('[data-testid="law-env-general"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    const path = container.querySelector('[data-testid="route"]')?.getAttribute("data-path") ?? "";
    expect(path).toBe("/app/general-bot");
    await act(async () => {
      root.unmount();
    });
  });

  it("does not show a stored case when the URL names a non-case bot", async () => {
    sessionStorage.setItem("law-environment:", "cases");
    const docs = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/law/cases") return jsonResponse(SYNTHETIC_CASES);
        if (url.includes("/documents")) return docs.promise;
        return new Response("not found", { status: 404 });
      }),
    );
    const { container, root } = await mountShell(
      createElement(
        SidebarProvider,
        null,
        createElement(RouteMark),
        createElement(LawEnvironmentRail),
        createElement(LawCaseTabs),
        createElement(LawCaseColumn),
      ),
      "/app/general-bot",
    );
    await act(async () => {});
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="law-env-cases"]')).not.toBeNull();
    });
    await act(async () => {
      await flush();
    });
    expect(container.querySelector('[data-testid="law-case-tabs"]')).toBeNull();
    expect(container.querySelector('[data-testid="law-column"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="law-env-general"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="law-env-cases"]')?.click();
    });
    expect(container.querySelector('[data-testid="route"]')?.getAttribute("data-path")).toBe(
      "/app/bot-ruiz",
    );
    await act(async () => {
      root.unmount();
    });
  });

  it("opens the case named by the URL even when general is stored", async () => {
    sessionStorage.setItem("law-environment:", "general");
    const { container, root } = await mountShell(
      createElement(
        SidebarProvider,
        null,
        createElement(RouteMark),
        createElement(LawEnvironmentRail),
        createElement(LawCaseTabs),
        createElement(LawCaseColumn),
      ),
      "/app/bot-ward",
    );
    await act(async () => {});
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="law-case-tab-ward"]')?.getAttribute("aria-pressed"),
      ).toBe("true");
    });
    expect(
      container.querySelector('[data-testid="law-env-general"]')?.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(container.querySelector('[data-testid="route"]')?.getAttribute("data-path")).toBe(
      "/app/bot-ward",
    );
    expect(container.querySelector('[data-testid="law-column"]')).not.toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  it("closes an open viewer and editor when the case changes", async () => {
    const wardDocs = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/law/cases") return jsonResponse(SYNTHETIC_CASES);
        if (url === "/api/law/cases/case-ruiz/documents") {
          return jsonResponse({
            documents: [
              lawFile("ruiz-pdf", "Ruiz Report", "library", "ruiz-report.pdf"),
              lawFile("ruiz-memo", "Ruiz Draft", "review", "ruiz-draft.md"),
            ],
          });
        }
        if (url === "/api/law/cases/case-ward/documents") return wardDocs.promise;
        return new Response("not found", { status: 404 });
      }),
    );
    const { container, root } = await mountShell(
      createElement(
        SidebarProvider,
        null,
        createElement(LawCaseTabs),
        createElement(LawCaseColumn),
      ),
      "/app/bot-ruiz",
    );
    await act(async () => {});
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="law-file-card-ruiz-pdf"]')).not.toBeNull();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="law-file-card-ruiz-pdf"] button')
        ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(
      container.querySelector('[data-testid="law-file-overlay"]')?.getAttribute("aria-label"),
    ).toBe("Ruiz Report");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="law-case-tab-ward"]')?.click();
    });
    expect(container.querySelector('[data-testid="law-file-overlay"]')).toBeNull();
    wardDocs.resolve(jsonResponse({ documents: [] }));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="law-case-tab-ruiz"]')?.click();
      await flush();
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="law-file-card-ruiz-memo"]')).not.toBeNull();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="law-file-card-ruiz-memo"] button')
        ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="law-doc-editor"]')).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="law-case-tab-ward"]')?.click();
    });
    expect(container.querySelector('[data-testid="law-file-overlay"]')).toBeNull();
    expect(container.querySelector('[data-testid="law-doc-editor"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  it("leaves the aside empty when the open case's documents fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/law/cases") return jsonResponse(SYNTHETIC_CASES);
        if (url === "/api/law/cases/case-ruiz/documents") {
          return jsonResponse({ documents: [lawFile("ruiz-doc", "Ruiz Memo")] });
        }
        if (url === "/api/law/cases/case-ward/documents")
          return new Response("no", { status: 500 });
        return new Response("not found", { status: 404 });
      }),
    );
    const { container, root } = await mountShell(
      createElement(
        SidebarProvider,
        null,
        createElement(LawCaseTabs),
        createElement(LawCaseColumn),
      ),
      "/app/bot-ruiz",
    );
    await act(async () => {});
    await vi.waitFor(() => {
      expect(columnTitles(container)).toEqual(["Ruiz Memo"]);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="law-case-tab-ward"]')?.click();
      await flush();
    });
    expect(container.querySelector('[data-testid="law-column"]')).not.toBeNull();
    expect(columnTitles(container)).toEqual([]);
    expect(container.textContent).not.toContain("Ruiz Memo");
    await act(async () => {
      root.unmount();
    });
  });
});
