// @vitest-environment jsdom

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { landInCasesSpace, selectedSpaceId, selectSpace } from "./lib.js";

describe("law space selection", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
});
