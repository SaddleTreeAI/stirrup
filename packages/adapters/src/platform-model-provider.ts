import { randomUUID } from "node:crypto";
import type { ModelCallObserver, SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  PlatformModelBudgetError,
  reservePlatformModelCall,
  runAsSystem,
  setPlatformModelRequestId,
  settlePlatformModelCall,
} from "@rakazo/db";
import { parseModelSecret } from "./model-secret.js";

export type PlatformCompanyModels = ReadonlyMap<string, readonly string[]>;

/** Company catalog selection is based on active grants, never on a deployment env key. */
export async function platformCompanyModels(
  prisma: PrismaClient,
  userId: string,
): Promise<PlatformCompanyModels> {
  return runAsSystem("list member's allowed company provider models", async () => {
    const deployment = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { platformMode: true },
    });
    if (!deployment?.platformMode) return new Map();
    const [user, grants] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          deactivatedAt: true,
          platformMonitoringAcceptedAt: true,
          platformRole: true,
          emailVerified: true,
        },
      }),
      prisma.platformModelGrant.findMany({
        where: {
          userId,
          enabled: true,
          connection: { enabled: true },
        },
        select: { connection: { select: { provider: true } }, allowedModelIds: true },
      }),
    ]);
    if (
      !user ||
      user.deactivatedAt ||
      !user.emailVerified ||
      (!user.platformMonitoringAcceptedAt && user.platformRole !== "owner")
    )
      return new Map();
    const models = new Map<string, string[]>();
    for (const grant of grants) {
      const known = models.get(grant.connection.provider) ?? [];
      models.set(grant.connection.provider, [...new Set([...known, ...grant.allowedModelIds])]);
    }
    return models;
  });
}

export async function platformCompanyMode(prisma: PrismaClient): Promise<boolean> {
  return runAsSystem("read private platform mode for model routing", async () =>
    Boolean(
      (
        await prisma.deploymentSettings.findUnique({
          where: { id: "default" },
          select: { platformMode: true },
        })
      )?.platformMode,
    ),
  );
}

export type ResolvedPlatformModelProvider = {
  grantId: string;
  connectionId: string;
  secretId: string;
  provider: string;
  model: string;
  key: string;
  countsTowardUserBudget: boolean;
};

/** Loads a key only after a matching, active, consented user's explicit grant is found. */
export async function resolvePlatformModelProvider(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  scope: { userId: string; spaceId: string; runId?: string; botId?: string },
  provider: string,
  model: string,
): Promise<ResolvedPlatformModelProvider | null> {
  const access = await runAsSystem(
    "authorize company model use for one provider and model",
    async () => {
      const deployment = await prisma.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { platformMode: true },
      });
      if (!deployment?.platformMode) return null;
      const [user, grant] = await Promise.all([
        prisma.user.findUnique({
          where: { id: scope.userId },
          select: {
            deactivatedAt: true,
            platformMonitoringAcceptedAt: true,
            platformRole: true,
            emailVerified: true,
          },
        }),
        prisma.platformModelGrant.findFirst({
          where: {
            userId: scope.userId,
            enabled: true,
            allowedModelIds: { has: model },
            connection: { provider, enabled: true },
          },
          select: {
            id: true,
            countsTowardUserBudget: true,
            connection: { select: { id: true, secretId: true, provider: true } },
          },
        }),
      ]);
      if (
        !user ||
        user.deactivatedAt ||
        !user.emailVerified ||
        (!user.platformMonitoringAcceptedAt && user.platformRole !== "owner") ||
        !grant
      )
        return null;
      const secret = await prisma.secret.findUnique({
        where: { id: grant.connection.secretId },
        select: { id: true, ciphertext: true },
      });
      return secret ? { grant, secret } : null;
    },
  );
  if (!access) return null;
  const plaintext = await secrets.load(access.secret.ciphertext, access.secret.id);
  const parsed = parseModelSecret(plaintext);
  if (parsed.kind !== "api_key") throw new Error("Company provider connection is not an API key");
  return {
    grantId: access.grant.id,
    connectionId: access.grant.connection.id,
    secretId: access.secret.id,
    provider: access.grant.connection.provider,
    model,
    key: parsed.key,
    countsTowardUserBudget: access.grant.countsTowardUserBudget,
  };
}

export function platformModelCallObserver(
  prisma: PrismaClient,
  access: ResolvedPlatformModelProvider,
  scope: { userId: string; spaceId: string; runId?: string; botId?: string },
): ModelCallObserver {
  return {
    reserveFullContextWindow: access.countsTowardUserBudget,
    beforeCall: (call) =>
      reservePlatformModelCall(
        prisma,
        {
          callId: call.callId ?? randomUUID(),
          grantId: access.grantId,
          connectionId: access.connectionId,
          secretId: access.secretId,
          userId: scope.userId,
          spaceId: scope.spaceId,
          runId: call.runId ?? scope.runId,
          botId: scope.botId,
          provider: call.provider,
          model: call.modelId,
        },
        access.countsTowardUserBudget ? call.maxCostUsd : undefined,
      ),
    afterCall: (reservationId, usage) => settlePlatformModelCall(prisma, reservationId, usage),
    onRequestId: (reservationId, providerRequestId) =>
      setPlatformModelRequestId(prisma, reservationId, providerRequestId),
  };
}

export function isPlatformModelBudgetError(error: unknown): error is PlatformModelBudgetError {
  return error instanceof PlatformModelBudgetError;
}
