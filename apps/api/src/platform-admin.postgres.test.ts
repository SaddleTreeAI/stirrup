import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPlatformInvite,
  listPlatformUsers,
  platformAdminOverview,
  previewPlatformInvite,
  requireCanDeactivatePlatformAccount,
  requirePlatformRole,
  resendPlatformProvision,
  setPlatformMonthlyBudget,
  setPlatformProvisionRole,
  setPlatformRole,
} from "./platform-admin.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("platform administration (PostgreSQL)", { timeout: 120_000 }, () => {
  const suffix = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const ids = ["owner", "admin", "member"].map((role) => `platform-${role}-${suffix}`);
  const legacyUserId = `platform-legacy-${suffix}`;
  const inviteToken = randomBytes(32).toString("base64url");
  let inviteId: string;
  let provisionId: string;
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    system = asSystem(db.prisma);
    await system.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", platformMode: true },
      update: { platformMode: true },
    });
    for (const [index, role] of (["owner", "admin", "member"] as const).entries()) {
      await system.user.create({
        data: {
          id: ids[index]!,
          email: `${ids[index]}@example.test`,
          name: role,
          emailVerified: true,
          platformRole: role,
          ...(role === "owner" ? {} : { platformMonitoringAcceptedAt: new Date() }),
        },
      });
    }
    await system.user.create({
      data: {
        id: legacyUserId,
        email: `${legacyUserId}@example.test`,
        name: "Unenrolled legacy user",
        emailVerified: true,
      },
    });
    const invite = await system.platformInvite.create({
      data: {
        email: `invite-${suffix}@example.test`,
        name: "Invited Staff",
        role: "member",
        tokenHash: createHash("sha256").update(inviteToken).digest("hex"),
        createdByUserId: ids[0]!,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    inviteId = invite.id;
    await system.usageRecord.create({
      data: {
        userId: ids[2]!,
        spaceId: `platform-space-${suffix}`,
        provider: "offline-test",
        model: "offline-test",
        inputTokens: 17,
        outputTokens: 23,
        costUsd: null,
      },
    });
    const currentMonth = new Date();
    currentMonth.setUTCDate(1);
    currentMonth.setUTCHours(0, 0, 0, 0);
    await system.platformModelBudgetBucket.create({
      data: {
        userId: ids[2]!,
        monthStart: currentMonth,
        chargedMicros: 7_500_000n,
        reservedMicros: 2_000_000n,
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await system.usageRecord.deleteMany({ where: { userId: { in: ids } } });
    await system.platformModelBudgetAlert.deleteMany({ where: { userId: { in: ids } } });
    await system.platformModelBudgetBucket.deleteMany({ where: { userId: { in: ids } } });
    await system.platformInvite.deleteMany({ where: { id: inviteId } });
    if (provisionId) await system.platformInvite.deleteMany({ where: { id: provisionId } });
    await system.user.deleteMany({ where: { id: { in: [...ids, legacyUserId] } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("authorizes persistent roles and refuses a disabled platform", async () => {
    await expect(requirePlatformRole(system, ids[0]!)).resolves.toBe("owner");
    await expect(requirePlatformRole(system, ids[1]!)).resolves.toBe("admin");
    await expect(requirePlatformRole(system, ids[2]!)).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await expect(requirePlatformRole(system, legacyUserId)).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    await system.deploymentSettings.update({
      where: { id: "default" },
      data: { platformMode: false },
    });
    await expect(requirePlatformRole(system, ids[0]!)).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await system.deploymentSettings.update({
      where: { id: "default" },
      data: { platformMode: true },
    });
  });

  it("refuses self deactivation and never deactivates an owner through the admin API", () => {
    expect(() =>
      requireCanDeactivatePlatformAccount({
        actorUserId: ids[0]!,
        actorRole: "owner",
        targetUserId: ids[0]!,
        targetRole: "owner",
      }),
    ).toThrow("You cannot deactivate your own account");
    expect(() =>
      requireCanDeactivatePlatformAccount({
        actorUserId: ids[1]!,
        actorRole: "admin",
        targetUserId: ids[0]!,
        targetRole: "owner",
      }),
    ).toThrow("Platform owners cannot be deactivated here");
    expect(() =>
      requireCanDeactivatePlatformAccount({
        actorUserId: ids[1]!,
        actorRole: "admin",
        targetUserId: ids[2]!,
        targetRole: "member",
      }),
    ).not.toThrow();
  });

  it("protects the last owner and reports incomplete per-user cost as unknown", async () => {
    await expect(setPlatformRole(system, ids[1]!, ids[2]!, "admin")).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    await expect(setPlatformRole(system, ids[0]!, ids[2]!, "admin")).resolves.toMatchObject({
      role: "admin",
    });
    await setPlatformRole(system, ids[0]!, ids[2]!, "member");
    await expect(setPlatformRole(system, ids[0]!, ids[0]!, "member")).rejects.toMatchObject({
      kind: "CONFLICT",
    });
    const users = await listPlatformUsers(system, ids[0]!);
    expect(users.some((user) => user.id === legacyUserId)).toBe(true);
    expect(users.find((user) => user.id === legacyUserId)).toMatchObject({
      emailVerified: true,
      monitoringAccepted: false,
      active: true,
      role: "member",
    });
    await expect(setPlatformRole(system, ids[0]!, legacyUserId, "admin")).resolves.toMatchObject({
      id: legacyUserId,
      role: "admin",
      monitoringAccepted: false,
    });
    await expect(requirePlatformRole(system, legacyUserId)).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    expect(users.find((user) => user.id === ids[2])).toMatchObject({
      monthToDateInputTokens: 17,
      monthToDateOutputTokens: 23,
      monthToDateCostUsd: null,
      monthToDateCalls: 1,
      monthlyBudgetUsd: 100,
      companyBudgetChargedUsd: 7.5,
      companyBudgetReservedUsd: 2,
    });
    await setPlatformMonthlyBudget(system, ids[0]!, ids[2]!, 10);
    let updatedUser = (await listPlatformUsers(system, ids[0]!)).find((user) => user.id === ids[2]);
    expect(updatedUser?.companyBudgetAlerts.map((alert) => alert.thresholdPercent)).toEqual([80]);
    await setPlatformMonthlyBudget(system, ids[0]!, ids[2]!, 9);
    updatedUser = (await listPlatformUsers(system, ids[0]!)).find((user) => user.id === ids[2]);
    expect(updatedUser?.companyBudgetAlerts.map((alert) => alert.thresholdPercent)).toEqual([
      80, 100,
    ]);
    await expect(platformAdminOverview(system)).resolves.toMatchObject({
      users: expect.any(Number),
    });
  });

  it("reveals only the safe invite preview for a valid bearer token", async () => {
    await expect(previewPlatformInvite(system, inviteToken)).resolves.toMatchObject({
      email: `invite-${suffix}@example.test`,
      name: "Invited Staff",
      expiresAt: expect.any(String),
    });
    await expect(
      previewPlatformInvite(system, "invalid-token-value".repeat(3)),
    ).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
  });

  it("lists owner-created accounts pending activation and allows role edit, expiry restore, and revocation", async () => {
    const email = `provision-${suffix}@example.test`;
    const created = await createPlatformInvite(
      {
        prisma: system,
        email: undefined,
        env: { webOrigin: "https://staff.example.test" },
      } as never,
      ids[0]!,
      { email, name: "Provisioned Staff", role: "member" },
      "provision",
    );
    provisionId = created.invite.id;
    expect(created.url).toMatch(/^https:\/\/staff\.example\.test\/invite\?platformToken=/);

    await setPlatformProvisionRole(system, ids[0]!, provisionId, "admin");
    await system.platformInvite.update({
      where: { id: provisionId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const pending = (await listPlatformUsers(system, ids[0]!)).find(
      (user) => user.activationInviteId === provisionId,
    );
    expect(pending).toMatchObject({
      email,
      name: "Provisioned Staff",
      role: "admin",
      pendingActivation: true,
      active: false,
    });
    expect(Date.parse(pending!.activationExpiresAt!)).toBeLessThan(Date.now());

    const reissued = await resendPlatformProvision(
      {
        prisma: system,
        email: undefined,
        env: { webOrigin: "https://staff.example.test" },
      } as never,
      ids[0]!,
      provisionId,
    );
    expect(reissued.url).toMatch(/^https:\/\/staff\.example\.test\/invite\?platformToken=/);
    expect(Date.parse(reissued.expiresAt)).toBeGreaterThan(Date.now());
    await expect(
      previewPlatformInvite(system, created.url.split("platformToken=")[1]!),
    ).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
    await system.platformInvite.update({
      where: { id: provisionId },
      data: { revokedAt: new Date() },
    });
    await expect(
      resendPlatformProvision(
        {
          prisma: system,
          email: undefined,
          env: { webOrigin: "https://staff.example.test" },
        } as never,
        ids[0]!,
        provisionId,
      ),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });
});
