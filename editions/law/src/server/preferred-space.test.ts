// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { describe, expect, it, vi } from "vitest";
import { preferredCasesSpaceId } from "./preferred-space.js";

vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...actual,
    runAsSystem: async <T>(_reason: string, work: () => Promise<T>) => work(),
  };
});

describe("preferredCasesSpaceId", () => {
  it("returns null when the current Space already has the user's cases", async () => {
    const prisma = {
      lawCaseMember: {
        findMany: vi.fn(async () => [{ caseId: "case-1" }]),
      },
      lawCase: {
        findMany: vi.fn(async () => [{ spaceId: "space-here", position: 0 }]),
      },
      spaceMember: { findFirst: vi.fn() },
    };
    await expect(
      preferredCasesSpaceId(prisma as never, "user-1", "space-here"),
    ).resolves.toBeNull();
    expect(prisma.lawCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null }),
      }),
    );
    expect(prisma.spaceMember.findFirst).not.toHaveBeenCalled();
  });

  it("returns the Space that holds the user's cases when the current one does not", async () => {
    const prisma = {
      lawCaseMember: {
        findMany: vi.fn(async () => [{ caseId: "case-1" }]),
      },
      lawCase: {
        findMany: vi.fn(async () => [{ spaceId: "space-cases", position: 0 }]),
      },
      spaceMember: {
        findFirst: vi.fn(async () => ({ spaceId: "space-cases" })),
      },
    };
    await expect(preferredCasesSpaceId(prisma as never, "user-1", "space-empty")).resolves.toBe(
      "space-cases",
    );
    expect(prisma.spaceMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          spaceId: "space-cases",
          space: { deletingAt: null },
        },
      }),
    );
  });

  it("returns null when the user has no case memberships", async () => {
    const prisma = {
      lawCaseMember: { findMany: vi.fn(async () => []) },
      lawCase: { findMany: vi.fn() },
      spaceMember: { findFirst: vi.fn() },
    };
    await expect(
      preferredCasesSpaceId(prisma as never, "user-1", "space-empty"),
    ).resolves.toBeNull();
    expect(prisma.lawCase.findMany).not.toHaveBeenCalled();
  });
});
