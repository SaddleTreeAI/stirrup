import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { runAsSystem } from "./row-security.js";

export const PLATFORM_MODEL_BUDGET_EXHAUSTED_ERROR =
  "Company model budget reached. Ask your workspace owner to adjust your limit.";
export const PLATFORM_MODEL_UNPRICED_ERROR =
  "This model has no reliable price; company-budgeted calls are blocked.";

export class PlatformModelBudgetError extends Error {
  constructor(readonly reason: "exhausted" | "unpriced") {
    super(
      reason === "exhausted"
        ? PLATFORM_MODEL_BUDGET_EXHAUSTED_ERROR
        : PLATFORM_MODEL_UNPRICED_ERROR,
    );
    this.name = "PlatformModelBudgetError";
  }
}

type PlatformModelAttribution = {
  callId: string;
  grantId: string;
  connectionId: string;
  secretId?: string;
  userId: string;
  spaceId: string;
  runId?: string;
  botId?: string;
  provider: string;
  model: string;
};

type ModelCallReceipt = {
  costUsd?: number | null;
  usageSource?: string | null;
};

const MICROS_PER_DOLLAR = 1_000_000;

function costMicros(costUsd: number | undefined): bigint {
  if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0 || costUsd > 10_000)
    throw new PlatformModelBudgetError("unpriced");
  return BigInt(Math.ceil(costUsd * MICROS_PER_DOLLAR));
}

function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Called while the user's budget bucket is locked by the surrounding transaction. */
export async function recordPlatformBudgetThresholdAlerts(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    monthStart: Date;
    budgetMicros: bigint;
    chargedMicros: bigint;
    reservedMicros: bigint;
    now?: Date;
  },
): Promise<void> {
  if (input.budgetMicros <= 0n) return;
  const used = input.chargedMicros + input.reservedMicros;
  const thresholds = ([80, 100] as const).filter(
    (threshold) => used * 100n >= input.budgetMicros * BigInt(threshold),
  );
  if (thresholds.length === 0) return;
  await tx.platformModelBudgetAlert.createMany({
    data: thresholds.map((thresholdPercent) => ({
      id: randomUUID(),
      userId: input.userId,
      monthStart: input.monthStart,
      thresholdPercent,
      createdAt: input.now,
    })),
    skipDuplicates: true,
  });
}

/** Reserve a known maximum atomically, or record an explicit unmetered company call. */
export async function reservePlatformModelCall(
  prisma: PrismaClient,
  attribution: PlatformModelAttribution,
  maxCostUsd: number | undefined,
  now = new Date(),
): Promise<string> {
  return runAsSystem("reserve company model call and enforce explicit grant budget", () =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${attribution.callId}))`;
      const [grant, deployment] = await Promise.all([
        tx.platformModelGrant.findFirst({
          where: {
            id: attribution.grantId,
            userId: attribution.userId,
            enabled: true,
            allowedModelIds: { has: attribution.model },
            connectionId: attribution.connectionId,
            connection: { enabled: true, provider: attribution.provider },
            user: {
              deactivatedAt: null,
              emailVerified: true,
              OR: [{ platformMonitoringAcceptedAt: { not: null } }, { platformRole: "owner" }],
            },
          },
          select: {
            countsTowardUserBudget: true,
            connection: { select: { secretId: true } },
          },
        }),
        tx.deploymentSettings.findUnique({
          where: { id: "default" },
          select: { platformMode: true },
        }),
      ]);
      if (
        !deployment?.platformMode ||
        !grant ||
        (attribution.secretId !== undefined && attribution.secretId !== grant.connection.secretId)
      )
        throw new Error("Company model access was revoked or is unavailable");

      const existing = await tx.platformModelCall.findUnique({
        where: { callId: attribution.callId },
        select: { id: true, grantId: true, userId: true },
      });
      if (existing) {
        if (existing.grantId !== attribution.grantId || existing.userId !== attribution.userId)
          throw new Error("Model call belongs to another company grant");
        // The observer gates exactly one outbound provider request. Reusing any
        // reservation could issue a second request without a second budget hold.
        throw new Error("Company model call reservation was already used");
      }

      const budgeted = grant.countsTowardUserBudget;
      const callAttribution = {
        callId: attribution.callId,
        grantId: attribution.grantId,
        connectionId: attribution.connectionId,
        userId: attribution.userId,
        spaceId: attribution.spaceId,
        runId: attribution.runId,
        botId: attribution.botId,
        provider: attribution.provider,
        model: attribution.model,
      };
      const reservedMicros = budgeted ? costMicros(maxCostUsd) : 0n;
      const monthStart = budgeted ? utcMonthStart(now) : null;
      if (budgeted && monthStart) {
        await tx.platformModelBudgetBucket.upsert({
          where: { userId_monthStart: { userId: attribution.userId, monthStart } },
          create: {
            id: randomUUID(),
            userId: attribution.userId,
            monthStart,
          },
          update: {},
        });
        const [bucket] = await tx.$queryRaw<
          Array<{ id: string; reservedMicros: bigint; chargedMicros: bigint }>
        >`SELECT id, "reservedMicros", "chargedMicros" FROM "platform_model_budget_buckets"
          WHERE "userId" = ${attribution.userId} AND "monthStart" = ${monthStart} FOR UPDATE`;
        const user = await tx.user.findUnique({
          where: { id: attribution.userId },
          select: { platformMonthlyBudgetMicros: true },
        });
        if (!user || user.platformMonthlyBudgetMicros < 0n)
          throw new Error("Company model budget is unavailable");
        if (
          !bucket ||
          bucket.reservedMicros + bucket.chargedMicros + reservedMicros >
            user.platformMonthlyBudgetMicros
        )
          throw new PlatformModelBudgetError("exhausted");
        await tx.platformModelBudgetBucket.update({
          where: { id: bucket.id },
          data: { reservedMicros: { increment: reservedMicros } },
        });
        await recordPlatformBudgetThresholdAlerts(tx, {
          userId: attribution.userId,
          monthStart,
          budgetMicros: user.platformMonthlyBudgetMicros,
          chargedMicros: bucket.chargedMicros,
          reservedMicros: bucket.reservedMicros + reservedMicros,
          now,
        });
      }
      return (
        await tx.platformModelCall.create({
          data: {
            ...callAttribution,
            id: randomUUID(),
            monthStart,
            budgeted,
            reservedMicros,
          },
        })
      ).id;
    }),
  );
}

/** Settle actual provider cost; unknown receipts keep the full reservation held. */
export async function settlePlatformModelCall(
  prisma: PrismaClient,
  id: string,
  receipt: ModelCallReceipt | null,
  now = new Date(),
): Promise<void> {
  await runAsSystem("settle company model call reservation", () =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "platform_model_calls" WHERE id = ${id} FOR UPDATE`;
      const call = await tx.platformModelCall.findUnique({ where: { id } });
      if (!call || ["settled", "released"].includes(call.state)) return;
      if (receipt?.costUsd == null) {
        await tx.platformModelCall.update({ where: { id }, data: { state: "unknown" } });
        return;
      }
      if (!Number.isFinite(receipt.costUsd) || receipt.costUsd < 0)
        throw new Error("Invalid company model call cost");
      const actualMicros = BigInt(Math.ceil(receipt.costUsd * MICROS_PER_DOLLAR));
      const release =
        actualMicros === 0n &&
        ["not-started", "provider-rejected"].includes(receipt.usageSource ?? "");
      if (call.budgeted && call.monthStart) {
        const [bucket] = await tx.$queryRaw<
          Array<{ id: string; reservedMicros: bigint; chargedMicros: bigint }>
        >`SELECT id, "reservedMicros", "chargedMicros" FROM "platform_model_budget_buckets"
          WHERE "userId" = ${call.userId} AND "monthStart" = ${call.monthStart} FOR UPDATE`;
        const user = await tx.user.findUnique({
          where: { id: call.userId },
          select: { platformMonthlyBudgetMicros: true },
        });
        if (!bucket || !user) throw new Error("Company model budget is unavailable");
        const chargedMicros = bucket.chargedMicros + (release ? 0n : actualMicros);
        const reservedMicros = bucket.reservedMicros - call.reservedMicros;
        await tx.platformModelBudgetBucket.update({
          where: { userId_monthStart: { userId: call.userId, monthStart: call.monthStart } },
          data: {
            reservedMicros: { decrement: call.reservedMicros },
            ...(release ? {} : { chargedMicros: { increment: actualMicros } }),
          },
        });
        await recordPlatformBudgetThresholdAlerts(tx, {
          userId: call.userId,
          monthStart: call.monthStart,
          budgetMicros: user.platformMonthlyBudgetMicros,
          chargedMicros,
          reservedMicros,
          now,
        });
      }
      await tx.platformModelCall.update({
        where: { id },
        data: {
          state: release ? "released" : "settled",
          actualMicros: release ? 0n : actualMicros,
          settledAt: now,
        },
      });
    }),
  );
}

export async function setPlatformModelRequestId(
  prisma: PrismaClient,
  id: string,
  providerRequestId: string,
): Promise<void> {
  await runAsSystem("record company model provider request id", () =>
    prisma.platformModelCall.updateMany({
      where: { id, providerRequestId: null },
      data: { providerRequestId },
    }),
  );
}
