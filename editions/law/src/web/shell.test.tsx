// @vitest-environment jsdom

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { deferred } from "@rakazo/core/test-async";
import { SidebarProvider } from "@rakazo/ui-web/components/ui/sidebar";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyLawRoster } from "./roster.js";
import {
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
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/app"] },
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
    await act(async () => {
      root.unmount();
    });
  });
});
