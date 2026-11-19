// @vitest-environment jsdom

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  landInCasesSpace,
  selectedSpaceId,
  selectSpace,
  uploadLawDocument,
  withSpaceHeaders,
} from "./lib.js";

describe("law space selection", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("selects a Space in localStorage", () => {
    expect(selectSpace("space-defense")).toBe(true);
    expect(selectedSpaceId()).toBe("space-defense");
  });

  it("lands in the cases Space when a different Space is selected", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    expect(landInCasesSpace("space-defense")).toBe(true);
    expect(selectedSpaceId()).toBe("space-defense");
    expect(assign).toHaveBeenCalledWith("/app");
    expect(landInCasesSpace("space-defense")).toBe(false);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("uploads with space headers and reports indeterminate progress", async () => {
    const progress: Array<number | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBeInstanceOf(FormData);
        const headers = new Headers(init?.headers);
        expect(headers.get("x-rakazo-space-id")).toBe("space-1");
        return new Response(JSON.stringify({ document: { id: "up-1" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const result = await uploadLawDocument({
      caseId: "case-1",
      file: new File(["x"], "x.txt"),
      spaceId: "space-1",
      onProgress: (value) => progress.push(value),
    });
    expect(result).toEqual({ ok: true, document: { id: "up-1" } });
    expect(progress[0]).toBeNull();
    expect(progress.at(-1)).toBe(1);
    expect(withSpaceHeaders(undefined, "space-1").get("x-rakazo-space-id")).toBe("space-1");
  });
});
