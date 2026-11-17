import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rakazo/db", () => ({
  runAsSystem: (_reason: string, work: () => unknown) => work(),
  recordAuditEvent: vi.fn(async () => undefined),
}));

import { recordAuditEvent } from "@rakazo/db";
import { setBotAccess } from "./platform-bot-sharing.js";

describe("company bot sharing", () => {
  const grants = new Map<string, { permission: string }>([["manager", { permission: "manage" }]]);
  const upsert = vi.fn(
    async (input: {
      where: { botId_userId: { userId: string } };
      create: { permission: string };
      update: { permission: string };
    }) => {
      const permission = grants.get(input.where.botId_userId.userId)
        ? input.update.permission
        : input.create.permission;
      grants.set(input.where.botId_userId.userId, { permission });
      return { permission };
    },
  );
  const deleteMany = vi.fn(async ({ where }: { where: { userId: string } }) => {
    grants.delete(where.userId);
    return { count: 1 };
  });
  const prisma = {
    deploymentSettings: { findUnique: vi.fn(async () => ({ companySpaceId: "company" })) },
    bot: {
      findUnique: vi.fn(async () => ({ id: "bot", spaceId: "company", userId: "creator" })),
    },
    user: {
      findUnique: vi.fn(async () => ({ platformRole: "member" })),
      findMany: vi.fn(async () => [
        { id: "manager", name: "Manager", email: "manager@example.test", platformRole: "member" },
        { id: "target", name: "Target", email: "target@example.test", platformRole: "member" },
      ]),
    },
    platformBotGrant: {
      findUnique: vi.fn(
        async ({ where }: { where: { botId_userId: { userId: string } } }) =>
          grants.get(where.botId_userId.userId) ?? null,
      ),
      findMany: vi.fn(async () =>
        [...grants.entries()].map(([userId, value]) => ({ userId, ...value })),
      ),
    },
    spaceMember: {
      findUnique: vi.fn(async () => ({ id: "membership" })),
      findMany: vi.fn(async () => [{ userId: "manager" }, { userId: "target" }]),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) =>
      work({ platformBotGrant: { upsert, deleteMany } }),
    ),
  };

  beforeEach(() => {
    grants.clear();
    grants.set("manager", { permission: "manage" });
    vi.clearAllMocks();
  });

  it("lets a bot manager grant access and audits the target and permission", async () => {
    const state = await setBotAccess(prisma as never, "manager", "bot", "target", "edit");

    expect(upsert).toHaveBeenCalledOnce();
    expect(state).toMatchObject({ isCompanyBot: true, canManage: true });
    expect(state.members.find(({ userId }) => userId === "target")?.permission).toBe("edit");
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "platform.bot_access.granted",
        metadata: { targetUserId: "target", permission: "edit" },
      }),
    );
  });

  it("refuses a member without manage permission before changing grants", async () => {
    grants.set("manager", { permission: "use" });

    await expect(
      setBotAccess(prisma as never, "manager", "bot", "target", "edit"),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    expect(upsert).not.toHaveBeenCalled();
  });
});
