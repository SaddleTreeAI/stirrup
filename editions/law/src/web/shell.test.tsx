// @vitest-environment jsdom

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LawCaseTabs, LawEnvironmentRail, LawProvider } from "./shell.js";

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

function mountShell() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    createElement(
      MemoryRouter,
      { initialEntries: ["/app"] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: "/app/:botId?",
          element: createElement(
            LawProvider,
            null,
            createElement(LawEnvironmentRail),
            createElement(LawCaseTabs),
          ),
        }),
      ),
    ),
  );
  return { container, root };
}

describe("law shell chrome", () => {
  beforeEach(() => {
    sessionStorage.clear();
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
    const { container, root } = mountShell();
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
});
