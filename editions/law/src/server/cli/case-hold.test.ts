// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { describe, expect, it } from "vitest";
import { parseCaseHoldArgs, setCaseLegalHold } from "./case-hold.js";

describe("parseCaseHoldArgs", () => {
  it("requires id and on|off", () => {
    expect(parseCaseHoldArgs([])).toMatchObject({ error: expect.stringContaining("Usage") });
    expect(parseCaseHoldArgs(["case-1"])).toMatchObject({
      error: expect.stringContaining("Usage"),
    });
    expect(parseCaseHoldArgs(["case-1", "maybe"])).toMatchObject({
      error: expect.stringContaining("Usage"),
    });
  });

  it("parses on and off", () => {
    expect(parseCaseHoldArgs(["case-1", "on"])).toEqual({ caseId: "case-1", hold: true });
    expect(parseCaseHoldArgs(["case-1", "off"])).toEqual({ caseId: "case-1", hold: false });
  });
});

describe("setCaseLegalHold", () => {
  it("updates legalHold and refuses missing cases", async () => {
    const state = {
      id: "case-1",
      spaceId: "space-1",
      legalHold: false,
    };
    const audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];
    const prisma = {
      lawCase: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === state.id ? { ...state } : null,
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { legalHold: boolean };
        }) => {
          if (where.id !== state.id) throw new Error("missing");
          state.legalHold = data.legalHold;
          return { id: state.id, legalHold: state.legalHold, spaceId: state.spaceId };
        },
      },
      auditEvent: {
        createMany: async ({ data }: { data: Array<{ action: string; metadata: unknown }> }) => {
          for (const row of data) {
            audits.push({
              action: row.action,
              metadata: (row.metadata ?? {}) as Record<string, unknown>,
            });
          }
          return { count: data.length };
        },
      },
      space: {
        findUnique: async () => ({ organizationId: "org-1" }),
        findMany: async () => [{ id: "space-1", organizationId: "org-1" }],
      },
      user: { findUnique: async () => null },
      member: { findMany: async () => [], findFirst: async () => null },
    };

    await expect(
      setCaseLegalHold(prisma as never, { caseId: "missing", hold: true }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });

    const on = await setCaseLegalHold(prisma as never, { caseId: "case-1", hold: true });
    expect(on).toEqual({ ok: true, caseId: "case-1", legalHold: true });
    expect(state.legalHold).toBe(true);

    const off = await setCaseLegalHold(prisma as never, { caseId: "case-1", hold: false });
    expect(off).toEqual({ ok: true, caseId: "case-1", legalHold: false });
  });
});
