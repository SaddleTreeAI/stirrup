import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import {
  PlatformModelBudgetError,
  reservePlatformModelCall,
  settlePlatformModelCall,
} from "./platform-model-usage.js";
import { asSystem } from "./row-security.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("company provider usage ledger (PostgreSQL)", { timeout: 120_000 }, () => {
  const suffix = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const ids = {
    organization: `platform-model-org-${suffix}`,
    space: `platform-model-space-${suffix}`,
    user: `platform-model-user-${suffix}`,
    bot: `platform-model-bot-${suffix}`,
    secret: `platform-model-secret-${suffix}`,
    connection: `platform-model-connection-${suffix}`,
    grant: `platform-model-grant-${suffix}`,
  };
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let settingsBefore: { platformMode: boolean; companySpaceId: string | null } | null;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = asSystem(db.prisma);
    settingsBefore = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { platformMode: true, companySpaceId: true },
    });
    await prisma.organization.create({
      data: {
        id: ids.organization,
        name: "Platform usage test",
        slug: ids.organization,
        createdAt: new Date(),
      },
    });
    await prisma.user.create({
      data: {
        id: ids.user,
        name: "Platform usage test",
        email: `${ids.user}@example.test`,
        emailVerified: true,
        platformMonitoringAcceptedAt: new Date(),
      },
    });
    await prisma.space.create({
      data: { id: ids.space, organizationId: ids.organization, name: "Platform usage test" },
    });
    await prisma.bot.create({
      data: {
        id: ids.bot,
        spaceId: ids.space,
        userId: ids.user,
        name: "Provider test bot",
        color: "#000",
      },
    });
    await prisma.secret.create({
      data: {
        id: ids.secret,
        userId: ids.user,
        kind: "platform_model_provider",
        ciphertext: "fake",
      },
    });
    await prisma.platformModelConnection.create({
      data: {
        id: ids.connection,
        provider: `test-provider-${suffix}`,
        label: "Test provider",
        secretId: ids.secret,
        createdByUserId: ids.user,
        enabled: true,
      },
    });
    await prisma.platformModelGrant.create({
      data: {
        id: ids.grant,
        userId: ids.user,
        connectionId: ids.connection,
        enabled: true,
        allowedModelIds: ["model-a"],
        countsTowardUserBudget: true,
      },
    });
    await prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", platformMode: true, companySpaceId: ids.space },
      update: { platformMode: true, companySpaceId: ids.space },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await prisma.platformModelCall.deleteMany({ where: { userId: ids.user } });
    await prisma.platformModelBudgetAlert.deleteMany({ where: { userId: ids.user } });
    await prisma.platformModelBudgetBucket.deleteMany({ where: { userId: ids.user } });
    await prisma.platformModelGrant.deleteMany({ where: { id: ids.grant } });
    await prisma.platformModelConnection.deleteMany({ where: { id: ids.connection } });
    await prisma.secret.deleteMany({ where: { id: ids.secret } });
    await prisma.organization.deleteMany({ where: { id: ids.organization } });
    await prisma.user.deleteMany({ where: { id: ids.user } });
    if (settingsBefore) {
      await prisma.deploymentSettings.update({
        where: { id: "default" },
        data: settingsBefore,
      });
    } else {
      await prisma.deploymentSettings.deleteMany({ where: { id: "default" } });
    }
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  const attribution = (callId = randomUUID()) => ({
    callId,
    grantId: ids.grant,
    connectionId: ids.connection,
    secretId: ids.secret,
    userId: ids.user,
    spaceId: ids.space,
    botId: ids.bot,
    provider: `test-provider-${suffix}`,
    model: "model-a",
  });

  beforeEach(async () => {
    await prisma.platformModelBudgetBucket.deleteMany({ where: { userId: ids.user } });
    await prisma.platformModelBudgetAlert.deleteMany({ where: { userId: ids.user } });
    await prisma.platformModelCall.deleteMany({ where: { userId: ids.user } });
    await prisma.user.update({
      where: { id: ids.user },
      data: { platformMonthlyBudgetMicros: 100_000_000n },
    });
    await prisma.platformModelGrant.update({
      where: { id: ids.grant },
      data: { enabled: true, allowedModelIds: ["model-a"], countsTowardUserBudget: true },
    });
    await prisma.platformModelConnection.update({
      where: { id: ids.connection },
      data: { enabled: true, secretId: ids.secret },
    });
    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { platformMode: true },
    });
  });

  it("atomically reserves one user's shared budget across concurrent calls", async () => {
    const calls = await Promise.allSettled([
      reservePlatformModelCall(prisma, attribution(), 60),
      reservePlatformModelCall(prisma, attribution(), 60),
    ]);
    expect(calls.filter((call) => call.status === "fulfilled")).toHaveLength(1);
    expect(calls.filter((call) => call.status === "rejected")).toHaveLength(1);
    const bucket = await prisma.platformModelBudgetBucket.findFirstOrThrow({
      where: { userId: ids.user },
    });
    expect(bucket.reservedMicros).toBe(60_000_000n);
    expect(bucket.chargedMicros).toBe(0n);
  });

  it("queues each 80% and 100% alert once as charged plus reserved usage crosses thresholds", async () => {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const first = await reservePlatformModelCall(prisma, attribution(), 80);
    expect(
      await prisma.platformModelBudgetAlert.findMany({
        where: { userId: ids.user, monthStart },
        orderBy: { thresholdPercent: "asc" },
        select: { thresholdPercent: true },
      }),
    ).toEqual([{ thresholdPercent: 80 }]);

    const second = await reservePlatformModelCall(prisma, attribution(), 20);
    expect(
      await prisma.platformModelBudgetAlert.findMany({
        where: { userId: ids.user, monthStart },
        orderBy: { thresholdPercent: "asc" },
        select: { thresholdPercent: true },
      }),
    ).toEqual([{ thresholdPercent: 80 }, { thresholdPercent: 100 }]);

    await settlePlatformModelCall(prisma, first, { costUsd: 80, usageSource: "provider" });
    await settlePlatformModelCall(prisma, second, { costUsd: 20, usageSource: "provider" });
    expect(
      await prisma.platformModelBudgetAlert.count({ where: { userId: ids.user, monthStart } }),
    ).toBe(2);
  });

  it("queues a threshold when actual settlement exceeds the held reservation", async () => {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const reservation = await reservePlatformModelCall(prisma, attribution(), 1);
    await settlePlatformModelCall(prisma, reservation, { costUsd: 80, usageSource: "provider" });
    await settlePlatformModelCall(prisma, reservation, { costUsd: 80, usageSource: "provider" });
    expect(
      await prisma.platformModelBudgetAlert.findMany({
        where: { userId: ids.user, monthStart },
        select: { thresholdPercent: true },
      }),
    ).toEqual([{ thresholdPercent: 80 }]);
    const bucket = await prisma.platformModelBudgetBucket.findFirstOrThrow({
      where: { userId: ids.user, monthStart },
    });
    expect(bucket.chargedMicros).toBe(80_000_000n);
    expect(bucket.reservedMicros).toBe(0n);
    await expect(reservePlatformModelCall(prisma, attribution(), 21)).rejects.toThrow(
      /budget reached/i,
    );
  });

  it("fails closed for unknown prices, accepts a known zero-price model, and never reuses a call id", async () => {
    await expect(reservePlatformModelCall(prisma, attribution(), undefined)).rejects.toBeInstanceOf(
      PlatformModelBudgetError,
    );
    const callId = randomUUID();
    const reservation = await reservePlatformModelCall(prisma, attribution(callId), 0);
    await expect(reservePlatformModelCall(prisma, attribution(callId), 0)).rejects.toThrow(
      /reservation was already used/,
    );
    await settlePlatformModelCall(prisma, reservation, {
      costUsd: 0,
      usageSource: "not-started",
    });
    const call = await prisma.platformModelCall.findUniqueOrThrow({ where: { callId } });
    expect(call.state).toBe("released");
  });

  it("rechecks grants before handling a replayed call id", async () => {
    const callId = randomUUID();
    await reservePlatformModelCall(prisma, attribution(callId), 1);
    await prisma.platformModelGrant.update({ where: { id: ids.grant }, data: { enabled: false } });
    await expect(reservePlatformModelCall(prisma, attribution(callId), 1)).rejects.toThrow(
      /revoked or is unavailable/,
    );
  });

  it("rejects a stale rotated secret and records unmetered grants without applying the user cap", async () => {
    await prisma.platformModelGrant.update({
      where: { id: ids.grant },
      data: { countsTowardUserBudget: false },
    });
    await expect(
      reservePlatformModelCall(prisma, { ...attribution(), secretId: `${ids.secret}-stale` }, 1),
    ).rejects.toThrow(/revoked or is unavailable/);
    const reservation = await reservePlatformModelCall(prisma, attribution(), undefined);
    await settlePlatformModelCall(prisma, reservation, { costUsd: 3.25, usageSource: "provider" });
    const call = await prisma.platformModelCall.findUniqueOrThrow({ where: { id: reservation } });
    expect(call.budgeted).toBe(false);
    expect(call.actualMicros).toBe(3_250_000n);
  });
});
