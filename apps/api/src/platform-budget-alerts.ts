import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { LeaseHeldError, runAsSystem, withLease } from "@rakazo/db";

const ALERT_LEASE_KEY = "platform-model-budget-alert-email";
const ALERT_LEASE_TTL_MS = 2 * 60 * 1000;
const ALERT_BATCH_SIZE = 100;

function currentMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

type AlertSweepDeps = {
  prisma: PrismaClient;
  email: TransactionalEmailProvider;
  onError(error: unknown): void;
};

function dollars(micros: bigint): string {
  return `$${(Number(micros) / 1_000_000).toFixed(2)}`;
}

/** Sends durable threshold alerts with at-least-once delivery under process failure. */
export function sendPlatformBudgetAlerts(deps: AlertSweepDeps) {
  return async (signal: AbortSignal): Promise<void> => {
    try {
      await runAsSystem("deliver pending company model budget alerts", () =>
        withLease(
          deps.prisma,
          ALERT_LEASE_KEY,
          { ttlMs: ALERT_LEASE_TTL_MS, signal },
          async (lease) => {
            const platformEnabled = await runAsSystem("check platform budget alert mode", () =>
              deps.prisma.deploymentSettings.findUnique({
                where: { id: "default" },
                select: { platformMode: true },
              }),
            );
            if (!platformEnabled?.platformMode) return;
            const alerts = await runAsSystem("claim pending company model budget alerts", () =>
              deps.prisma.platformModelBudgetAlert.findMany({
                where: {
                  sentAt: null,
                  monthStart: { gte: currentMonthStart() },
                  user: { emailVerified: true, deactivatedAt: null },
                },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                take: ALERT_BATCH_SIZE,
                select: {
                  id: true,
                  thresholdPercent: true,
                  monthStart: true,
                  user: {
                    select: {
                      id: true,
                      email: true,
                      platformMonthlyBudgetMicros: true,
                    },
                  },
                },
              }),
            );
            for (const alert of alerts) {
              lease.signal.throwIfAborted();
              try {
                const bucket = await runAsSystem("read company budget alert amount", () =>
                  deps.prisma.platformModelBudgetBucket.findUnique({
                    where: {
                      userId_monthStart: { userId: alert.user.id, monthStart: alert.monthStart },
                    },
                    select: { chargedMicros: true, reservedMicros: true },
                  }),
                );
                const used = (bucket?.chargedMicros ?? 0n) + (bucket?.reservedMicros ?? 0n);
                await deps.email.send({
                  to: alert.user.email,
                  subject: `Company model budget at ${alert.thresholdPercent}%`,
                  text: [
                    `Your company model usage has reached at least ${alert.thresholdPercent}% of your monthly limit.`,
                    `Usage: ${dollars(used)} of ${dollars(alert.user.platformMonthlyBudgetMicros)}.`,
                    `Month: ${alert.monthStart.toISOString().slice(0, 7)} UTC.`,
                    "Usage may include reserved requests and provider-reported estimates.",
                  ].join("\n"),
                });
                await runAsSystem("mark company model budget alert delivered", () =>
                  deps.prisma.platformModelBudgetAlert.updateMany({
                    where: { id: alert.id, sentAt: null },
                    data: { sentAt: new Date() },
                  }),
                );
              } catch (error) {
                deps.onError(error);
              }
            }
          },
        ),
      );
    } catch (error) {
      if (error instanceof LeaseHeldError) return;
      throw error;
    }
  };
}
