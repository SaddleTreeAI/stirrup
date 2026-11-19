// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  lawBotAccess,
  lawCaseAccess,
  lawDocumentFilename,
  lawTurnNote,
  limitLawTeammates,
  saveLawReviewDraft,
} from "./cases.js";

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};

describe("lawBotAccess / lawCaseAccess", () => {
  it("allows a bot that is not on any case", async () => {
    const prisma = {
      lawCaseBot: { findUnique: vi.fn(async () => null) },
      lawCaseMember: { findUnique: vi.fn() },
    };
    await expect(lawCaseAccess(prisma as never, actor.userId, "plain")).resolves.toBe("open");
    await expect(lawBotAccess(prisma as never, actor, "plain")).resolves.toBe("allow");
    expect(prisma.lawCaseMember.findUnique).not.toHaveBeenCalled();
  });

  it("allows a linked bot when the actor is a member", async () => {
    const prisma = {
      lawCaseBot: { findUnique: vi.fn(async () => ({ caseId: "case-1" })) },
      lawCaseMember: { findUnique: vi.fn(async () => ({ userId: actor.userId })) },
    };
    await expect(lawCaseAccess(prisma as never, actor.userId, "bot-1")).resolves.toBe("member");
    await expect(lawBotAccess(prisma as never, actor, "bot-1")).resolves.toBe("allow");
  });

  it("denies a linked bot when the actor is not a member", async () => {
    const prisma = {
      lawCaseBot: { findUnique: vi.fn(async () => ({ caseId: "case-1" })) },
      lawCaseMember: { findUnique: vi.fn(async () => null) },
    };
    await expect(lawCaseAccess(prisma as never, actor.userId, "bot-1")).resolves.toBe("denied");
    await expect(lawBotAccess(prisma as never, actor, "bot-1")).resolves.toBe("deny");
  });
});

describe("lawDocumentFilename", () => {
  it("uses an explicit name when provided", () => {
    expect(lawDocumentFilename("Anything", "library", "scan.PDF")).toBe("scan.PDF");
  });

  it("defaults review drafts to markdown", () => {
    expect(lawDocumentFilename("Motion to Suppress", "review")).toBe("motion-to-suppress.md");
  });

  it("defaults library files to text", () => {
    expect(lawDocumentFilename("Incident Report", "library")).toBe("incident-report.txt");
  });
});

describe("limitLawTeammates", () => {
  it("keeps same-case bots and non-case bots only", async () => {
    const prisma = {
      lawCaseBot: {
        findUnique: vi.fn(async () => ({ caseId: "case-a" })),
        findMany: vi.fn(async () => [
          { caseId: "case-a", botId: "bot-a1" },
          { caseId: "case-a", botId: "bot-a2" },
          { caseId: "case-b", botId: "bot-b1" },
        ]),
      },
    };
    const result = await limitLawTeammates(prisma as never, "bot-a1", [
      { id: "bot-a2" },
      { id: "bot-b1" },
      { id: "bot-plain" },
    ]);
    expect(result.map((bot) => bot.id)).toEqual(["bot-a2", "bot-plain"]);
  });
});

describe("lawTurnNote", () => {
  it("returns undefined for ordinary bots", async () => {
    const prisma = {
      lawCaseBot: { findUnique: vi.fn(async () => null) },
      lawCase: { findUnique: vi.fn() },
      lawDocument: { findMany: vi.fn() },
    };
    await expect(lawTurnNote(prisma as never, "plain", "question")).resolves.toBeUndefined();
    expect(prisma.lawCase.findUnique).not.toHaveBeenCalled();
  });

  it("formats the case brief and matching library snippets", async () => {
    const prisma = {
      lawCaseBot: { findUnique: vi.fn(async () => ({ caseId: "case-1" })) },
      lawCase: {
        findUnique: vi.fn(async () => ({
          id: "case-1",
          name: "Commonwealth v. Ward",
          brief: "Ward brief.",
          spaceId: "space-1",
        })),
      },
      lawDocument: {
        findMany: vi.fn(async () => [
          { id: "doc-1", title: "Lab report", body: "Item was caffeine." },
          { id: "doc-2", title: "Other", body: "No match here." },
        ]),
      },
    };
    const note = await lawTurnNote(prisma as never, "bot-1", "Was it caffeine?");
    expect(note).toContain("Commonwealth v. Ward");
    expect(note).toContain("caffeine");
    expect(note).not.toContain("No match here");
  });
});

describe("saveLawReviewDraft", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores unique violations on sourceRunId", async () => {
    const prisma = {
      lawCaseBot: {
        findUnique: vi.fn(async () => ({ caseId: "case-1", role: "generator" })),
      },
      lawCase: {
        findUnique: vi.fn(async () => ({ spaceId: "space-1" })),
      },
      lawDocument: {
        create: vi.fn(async () => {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }),
      },
    };
    await expect(
      saveLawReviewDraft(prisma as never, {
        botId: "gen",
        runId: "run-1",
        text: "SYNTHETIC DRAFT — NOT FOR FILING\nMotion",
      }),
    ).resolves.toBeUndefined();
    expect(prisma.lawDocument.create).toHaveBeenCalledOnce();
  });

  it("rethrows non-unique errors", async () => {
    const prisma = {
      lawCaseBot: {
        findUnique: vi.fn(async () => ({ caseId: "case-1", role: "generator" })),
      },
      lawCase: {
        findUnique: vi.fn(async () => ({ spaceId: "space-1" })),
      },
      lawDocument: {
        create: vi.fn(async () => {
          throw new Error("disk full");
        }),
      },
    };
    await expect(
      saveLawReviewDraft(prisma as never, {
        botId: "gen",
        runId: "run-1",
        text: "SYNTHETIC DRAFT — NOT FOR FILING\nMotion",
      }),
    ).rejects.toThrow("disk full");
  });
});
