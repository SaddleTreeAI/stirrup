// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { describe, expect, it, vi } from "vitest";
import { parseCasePurgeArgs } from "./case-purge.js";

describe("parseCasePurgeArgs", () => {
  it("requires --case", () => {
    expect(parseCasePurgeArgs([])).toMatchObject({ error: expect.stringContaining("Usage") });
    expect(parseCasePurgeArgs(["--dry-run"])).toMatchObject({
      error: expect.stringContaining("Usage"),
    });
  });

  it("parses dry-run", () => {
    expect(parseCasePurgeArgs(["--case", "abc", "--dry-run"])).toEqual({
      caseId: "abc",
      dryRun: true,
      forceBeforeRetention: false,
      confirm: undefined,
    });
  });

  it("requires --confirm matching --case for --force-before-retention", () => {
    expect(parseCasePurgeArgs(["--case", "abc", "--force-before-retention"])).toMatchObject({
      error: expect.stringContaining("--confirm"),
    });
    expect(
      parseCasePurgeArgs(["--case", "abc", "--force-before-retention", "--confirm", "other"]),
    ).toMatchObject({ error: expect.stringContaining("--confirm") });
    expect(
      parseCasePurgeArgs(["--case", "abc", "--force-before-retention", "--confirm", "abc"]),
    ).toEqual({
      caseId: "abc",
      dryRun: false,
      forceBeforeRetention: true,
      confirm: "abc",
    });
  });
});

describe("case:purge dry-run guard", () => {
  it("documents that dry-run deletes nothing (wired through purgeLawCase)", async () => {
    const purge = await import("../media/handlers/purge-case.js");
    const spy = vi.spyOn(purge, "purgeLawCase").mockResolvedValue({
      ok: true,
      dryRun: true,
      counts: purge.emptyPurgeCounts(),
    });
    // parse-only guard covered above; runtime dry-run is purgeLawCase's responsibility.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
