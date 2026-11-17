import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rakazo/db", () => ({
  runAsSystem: (_reason: string, work: () => unknown) => work(),
  recordAuditEvent: vi.fn(async () => undefined),
}));

import { recordAuditEvent } from "@rakazo/db";
import { listBotAccess, revokeBotAccess, setBotAccess } from "./platform-bot-sharing.js";

describe("company bot sharing", () => {
  const roles = new Map<string, string>([
    ["manager", "member"],
    ["target", "member"],
    ["creator", "member"],
    ["admin", "admin"],
    ["owner", "owner"],
  ]);
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
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const platformRole = roles.get(where.id);
        return platformRole ? { platformRole } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.flatMap((id) => {
          const platformRole = roles.get(id);
          return platformRole ? [{ id, name: id, email: `${id}@example.test`, platformRole }] : [];
        }),
      ),
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
      findMany: vi.fn(async () => [...roles.keys()].map((userId) => ({ userId }))),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) =>
      work({
        $queryRaw: vi.fn(async () => []),
        user: { findUnique: prisma.user.findUnique },
        spaceMember: { findUnique: prisma.spaceMember.findUnique },
        platformBotGrant: { upsert, deleteMany },
      }),
    ),
  };

  beforeEach(() => {
    grants.clear();
    grants.set("manager", { permission: "manage" });
    roles.clear();
    roles.set("manager", "member");
    roles.set("target", "member");
    roles.set("creator", "member");
    roles.set("admin", "admin");
    roles.set("owner", "owner");
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

  it("reports inherited owner and administrator access as effective manage and read-only", async () => {
    grants.set("admin", { permission: "use" });

    const state = await listBotAccess(prisma as never, "bot", "manager");
    const adminView = await listBotAccess(prisma as never, "bot", "admin");

    expect(state.members.find(({ userId }) => userId === "creator")).toMatchObject({
      permission: null,
      effectivePermission: "manage",
      inheritedAccess: "bot_owner",
      canChangePermission: false,
    });
    expect(state.members.find(({ userId }) => userId === "admin")).toMatchObject({
      permission: "use",
      effectivePermission: "manage",
      inheritedAccess: "platform_role",
      canChangePermission: false,
    });
    expect(state.members.find(({ userId }) => userId === "owner")).toMatchObject({
      effectivePermission: "manage",
      inheritedAccess: "platform_role",
      canChangePermission: false,
    });
    expect(state.members.find(({ userId }) => userId === "target")).toMatchObject({
      permission: null,
      effectivePermission: null,
      inheritedAccess: null,
      canChangePermission: true,
    });
    expect(adminView).toMatchObject({
      permission: "use",
      effectivePermission: "manage",
      inheritedAccess: "platform_role",
      canManage: true,
    });
  });

  it.each(["creator", "admin", "owner"])(
    "rejects explicit grant changes for inherited access (%s)",
    async (targetUserId) => {
      await expect(
        setBotAccess(prisma as never, "manager", "bot", targetUserId, "use"),
      ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
      await expect(
        revokeBotAccess(prisma as never, "manager", "bot", targetUserId),
      ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
      expect(upsert).not.toHaveBeenCalled();
      expect(deleteMany).not.toHaveBeenCalled();
    },
  );

  it("refuses a member without manage permission before changing grants", async () => {
    grants.set("manager", { permission: "use" });

    await expect(
      setBotAccess(prisma as never, "manager", "bot", "target", "edit"),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    expect(upsert).not.toHaveBeenCalled();
  });
});
