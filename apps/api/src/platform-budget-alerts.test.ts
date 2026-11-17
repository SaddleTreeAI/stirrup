import { describe, expect, it, vi } from "vitest";

vi.mock("@rakazo/db", () => ({
  LeaseHeldError: class LeaseHeldError extends Error {},
  runAsSystem: (_reason: string, fn: () => unknown) => fn(),
  withLease: async (
    _prisma: unknown,
    _key: string,
    _options: unknown,
    work: (lease: unknown) => unknown,
  ) => work({ signal: new AbortController().signal }),
}));

import { sendPlatformBudgetAlerts } from "./platform-budget-alerts.js";

function fixture() {
  const alert = {
    id: "alert-1",
    thresholdPercent: 80,
    monthStart: new Date("2026-11-01T00:00:00.000Z"),
    user: {
      id: "user-1",
      email: "staff@example.test",
      platformMonthlyBudgetMicros: 100_000_000n,
    },
  };
  const prisma = {
    deploymentSettings: {
      findUnique: vi.fn().mockResolvedValue({ platformMode: true }),
    },
    platformModelBudgetAlert: {
      findMany: vi.fn().mockResolvedValue([alert]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    platformModelBudgetBucket: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ chargedMicros: 70_000_000n, reservedMicros: 10_000_000n }),
    },
  };
  const email = { send: vi.fn().mockResolvedValue(undefined) };
  const onError = vi.fn();
  return { alert, prisma, email, onError };
}

describe("company model budget alert delivery", () => {
  it("emails only the affected user and marks the durable alert sent", async () => {
    const f = fixture();
    await sendPlatformBudgetAlerts({
      prisma: f.prisma as never,
      email: f.email as never,
      onError: f.onError,
    })(new AbortController().signal);
    expect(f.email.send).toHaveBeenCalledWith({
      to: "staff@example.test",
      subject: "Company model budget at 80%",
      text: expect.stringContaining("Usage: $80.00 of $100.00."),
    });
    expect(f.prisma.platformModelBudgetAlert.updateMany).toHaveBeenCalledWith({
      where: { id: "alert-1", sentAt: null },
      data: { sentAt: expect.any(Date) },
    });
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("keeps failed delivery pending for the next leased sweep", async () => {
    const f = fixture();
    f.email.send.mockRejectedValueOnce(new Error("temporary mail failure"));
    await sendPlatformBudgetAlerts({
      prisma: f.prisma as never,
      email: f.email as never,
      onError: f.onError,
    })(new AbortController().signal);
    expect(f.prisma.platformModelBudgetAlert.updateMany).not.toHaveBeenCalled();
    expect(f.onError).toHaveBeenCalledOnce();
  });

  it("does not deliver old alerts when platform mode is disabled", async () => {
    const f = fixture();
    f.prisma.deploymentSettings.findUnique.mockResolvedValueOnce({ platformMode: false });
    await sendPlatformBudgetAlerts({
      prisma: f.prisma as never,
      email: f.email as never,
      onError: f.onError,
    })(new AbortController().signal);
    expect(f.prisma.platformModelBudgetAlert.findMany).not.toHaveBeenCalled();
    expect(f.email.send).not.toHaveBeenCalled();
  });
});
