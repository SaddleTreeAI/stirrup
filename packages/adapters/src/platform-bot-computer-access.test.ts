import type { PrismaClient } from "@rakazo/db";
import { currentDbContext, resolvePlatformBotTenantScope, runAsTenant } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  resolvePlatformBotTenantScope: vi.fn(),
}));

import { withPlatformBotComputerAccess } from "./platform-bot-computer-access.js";

describe("platform bot computer access", () => {
  const actor = { spaceId: "company", userId: "member" };
  const computerFindFirst = vi.fn();
  const prisma = { computer: { findFirst: computerFindFirst } } as unknown as PrismaClient;
  const resolve = vi.mocked(resolvePlatformBotTenantScope);

  beforeEach(() => vi.clearAllMocks());

  it("refuses computer work after a company bot grant is revoked", async () => {
    resolve.mockResolvedValue({ kind: "denied" });
    const work = vi.fn(async () => "computer started");

    await expect(
      withPlatformBotComputerAccess(prisma, actor, "bot", "computer", work),
    ).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    expect(work).not.toHaveBeenCalled();
  });

  it("runs company computer work with a freshly resolved bot scope", async () => {
    resolve.mockResolvedValue({
      kind: "granted",
      scope: {
        ...actor,
        companySpaceId: "company",
        useBotIds: ["bot"],
        editBotIds: [],
        manageBotIds: [],
        requiredPermission: "use",
      },
    });
    computerFindFirst.mockResolvedValue({ id: "computer" });
    const work = vi.fn(async () => currentDbContext());

    await expect(
      withPlatformBotComputerAccess(prisma, actor, "bot", "computer", work),
    ).resolves.toMatchObject({
      kind: "tenant",
      spaceId: "company",
      userId: "member",
      platformBots: { useBotIds: ["bot"], requiredPermission: "use" },
    });
    expect(resolve).toHaveBeenCalledWith(prisma, {
      ...actor,
      botId: "bot",
      botIds: ["bot"],
      requiredPermission: "use",
    });
    expect(computerFindFirst).toHaveBeenCalledWith({
      where: { id: "computer" },
      select: { id: true },
    });
  });

  it("denies access when the shared computer has an ungranted attached bot", async () => {
    resolve.mockResolvedValue({
      kind: "granted",
      scope: {
        ...actor,
        companySpaceId: "company",
        useBotIds: ["bot"],
        editBotIds: [],
        manageBotIds: [],
        requiredPermission: "use",
      },
    });
    computerFindFirst.mockResolvedValue(null);
    const work = vi.fn(async () => "computer started");

    await expect(
      withPlatformBotComputerAccess(prisma, actor, "bot", "computer", work),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    expect(work).not.toHaveBeenCalled();
  });

  it("leaves ordinary Space computer access under the existing tenant context", async () => {
    resolve.mockResolvedValue({ kind: "not-company" });
    await runAsTenant(actor, async () => {
      await expect(
        withPlatformBotComputerAccess(prisma, actor, "bot", "computer", async () =>
          currentDbContext(),
        ),
      ).resolves.toEqual({ kind: "tenant", ...actor });
    });
  });
});
