// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";

/**
 * When the current Space has no cases the user can open, the Space that does —
 * so the client can land there instead of an empty Cases panel.
 */
export async function preferredCasesSpaceId(
  prisma: PrismaClient,
  userId: string,
  currentSpaceId: string,
): Promise<string | null> {
  return runAsSystem("find the Space that holds the user's law cases", async () => {
    const memberships = await prisma.lawCaseMember.findMany({
      where: { userId },
      select: { caseId: true },
    });
    if (memberships.length === 0) return null;
    const cases = await prisma.lawCase.findMany({
      where: { id: { in: memberships.map((row) => row.caseId) } },
      select: { spaceId: true, position: true },
      orderBy: [{ position: "asc" }, { id: "asc" }],
    });
    for (const item of cases) {
      if (item.spaceId === currentSpaceId) return null;
      const member = await prisma.spaceMember.findFirst({
        where: { userId, spaceId: item.spaceId, space: { deletingAt: null } },
        select: { spaceId: true },
      });
      if (member) return member.spaceId;
    }
    return null;
  });
}
