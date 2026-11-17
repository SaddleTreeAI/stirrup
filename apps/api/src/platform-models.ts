import { randomUUID } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import {
  creditsCanPriceModel,
  listPiCatalog,
  persistPreparedSecret,
  probeCatalogProviderModels,
  verifyCatalogProviderApiKey,
} from "@rakazo/adapters";
import type { PlatformModelConnection } from "@rakazo/contracts";
import { canonicalPiProviderId } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { recordSecurityEvent, runAsSystem } from "@rakazo/db";

type PlatformModelAdminDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
};

function providerDefinition(providerId: string) {
  const provider = canonicalPiProviderId(providerId);
  const models = listPiCatalog().filter((entry) => entry.provider === provider);
  if (!models.length || !models.some((entry) => entry.auth === "api-key" || entry.auth === "both"))
    throw new ClientError("BAD_REQUEST", "This provider cannot use a company API key");
  // Subscription-backed logins, especially account OAuth, must never be made a company key.
  if (models.some((entry) => entry.subscription))
    throw new ClientError(
      "BAD_REQUEST",
      "Subscription credentials cannot be shared by the company",
    );
  return { provider, models };
}

async function connectionRow(prisma: PrismaClient, providerId: string) {
  const provider = canonicalPiProviderId(providerId);
  return runAsSystem("read company provider connection for administration", () =>
    prisma.platformModelConnection.findUnique({
      where: { provider },
      include: {
        grants: {
          orderBy: [{ userId: "asc" }],
          select: {
            id: true,
            userId: true,
            enabled: true,
            allowedModelIds: true,
            countsTowardUserBudget: true,
          },
        },
      },
    }),
  );
}

function toDto(
  connection: NonNullable<Awaited<ReturnType<typeof connectionRow>>>,
): PlatformModelConnection {
  return {
    id: connection.id,
    provider: connection.provider,
    label: connection.label,
    enabled: connection.enabled,
    secretConfigured: true,
    grants: connection.grants,
  };
}

export async function listPlatformModelConnections(prisma: PrismaClient) {
  const rows = await runAsSystem("list redacted company provider connections", () =>
    prisma.platformModelConnection.findMany({
      include: {
        grants: {
          orderBy: [{ userId: "asc" }],
          select: {
            id: true,
            userId: true,
            enabled: true,
            allowedModelIds: true,
            countsTowardUserBudget: true,
          },
        },
      },
      orderBy: [{ provider: "asc" }],
    }),
  );
  return rows.map(toDto);
}

export function platformProviderOptions() {
  const grouped = new Map<string, { provider: string; providerName: string; modelCount: number }>();
  for (const model of listPiCatalog()) {
    if (model.subscription || (model.auth !== "api-key" && model.auth !== "both")) continue;
    const current = grouped.get(model.provider) ?? {
      provider: model.provider,
      providerName: model.providerName,
      modelCount: 0,
    };
    current.modelCount++;
    grouped.set(model.provider, current);
  }
  return [...grouped.values()].sort((left, right) =>
    left.providerName.localeCompare(right.providerName),
  );
}

export async function platformProviderCatalog(deps: PlatformModelAdminDeps, providerId: string) {
  const { provider, models } = providerDefinition(providerId);
  let dynamicModelIds: string[] | undefined;
  const connection = await connectionRow(deps.prisma, provider);
  if (connection?.enabled) {
    const secret = await runAsSystem("read company provider key for owner catalog", () =>
      deps.prisma.secret.findUnique({
        where: { id: connection.secretId },
        select: { id: true, ciphertext: true },
      }),
    );
    if (secret) {
      const plaintext = await deps.secrets.load(secret.ciphertext, secret.id);
      try {
        dynamicModelIds = await probeCatalogProviderModels({ provider, apiKey: plaintext });
      } catch {
        // Some first-party catalogs have no model endpoint; their bundled catalog remains usable.
      }
    }
  }
  const byId = new Map(models.map((model) => [model.id, model]));
  const modelIds = dynamicModelIds?.length ? dynamicModelIds : [...byId.keys()];
  return {
    provider,
    providerName: models[0]?.providerName ?? provider,
    models: modelIds
      .map((id) => byId.get(id) ?? { id, label: id, recommended: false })
      .map((model) => ({
        id: model.id,
        label: model.label,
        priced: creditsCanPriceModel({ provider, id: model.id }),
      })),
  };
}

export async function savePlatformModelConnection(
  deps: PlatformModelAdminDeps,
  actorUserId: string,
  input: { provider: string; label: string; apiKey?: string },
) {
  const { provider } = providerDefinition(input.provider);
  if (input.apiKey !== undefined)
    await verifyCatalogProviderApiKey({ provider, apiKey: input.apiKey });
  const existing = await connectionRow(deps.prisma, provider);
  if (input.apiKey === undefined) {
    if (!existing) throw new ClientError("BAD_REQUEST", "Enter an API key for this connection");
    const updated = await runAsSystem("rename company model provider connection", () =>
      deps.prisma.platformModelConnection.update({
        where: { provider },
        data: { label: input.label.trim() },
      }),
    );
    await recordSecurityEvent({
      type: "platform.provider.connection_saved",
      userId: actorUserId,
      metadata: { provider, action: "renamed" },
    });
    return toDto({ ...updated, grants: existing.grants });
  }

  const secretId = randomUUID();
  const stored = await deps.secrets.put(
    input.apiKey,
    {
      operationId: `company-model-${secretId}`,
      traceId: secretId,
      spaceId: "platform",
      userId: actorUserId,
      signal: new AbortController().signal,
    },
    { recordId: secretId },
  );
  const saved = await persistPreparedSecret(
    deps.prisma,
    deps.secrets,
    { id: stored.id, ciphertext: stored.ciphertext },
    () =>
      runAsSystem("save company model provider credential", () =>
        deps.prisma.$transaction(async (tx) => {
          await tx.secret.create({
            data: {
              id: stored.id,
              userId: actorUserId,
              kind: "platform_model_provider",
              ciphertext: stored.ciphertext,
            },
          });
          return tx.platformModelConnection.upsert({
            where: { provider },
            create: {
              id: randomUUID(),
              provider,
              label: input.label.trim(),
              secretId: stored.id,
              createdByUserId: actorUserId,
              enabled: false,
            },
            update: {
              label: input.label.trim(),
              secretId: stored.id,
            },
            include: {
              grants: {
                select: {
                  id: true,
                  userId: true,
                  enabled: true,
                  allowedModelIds: true,
                  countsTowardUserBudget: true,
                },
              },
            },
          });
        }),
      ),
  );
  if (existing && existing.secretId !== stored.id) {
    await runAsSystem("delete replaced company provider credential", () =>
      deps.prisma.secret.delete({ where: { id: existing.secretId } }),
    );
  }
  await recordSecurityEvent({
    type: "platform.provider.connection_saved",
    userId: actorUserId,
    metadata: { provider, action: existing ? "rotated" : "created" },
  });
  return toDto(saved);
}

export async function setPlatformModelConnectionEnabled(
  prisma: PrismaClient,
  actorUserId: string,
  providerId: string,
  enabled: boolean,
) {
  const { provider } = providerDefinition(providerId);
  const updated = await runAsSystem("change company model provider availability", () =>
    prisma.platformModelConnection.update({ where: { provider }, data: { enabled } }),
  );
  await recordSecurityEvent({
    type: enabled
      ? "platform.provider.connection_enabled"
      : "platform.provider.connection_disabled",
    userId: actorUserId,
    metadata: { provider },
  });
  const row = await connectionRow(prisma, provider);
  return toDto({ ...updated, grants: row?.grants ?? [] });
}

export async function deletePlatformModelConnection(
  deps: PlatformModelAdminDeps,
  actorUserId: string,
  providerId: string,
) {
  const { provider } = providerDefinition(providerId);
  const existing = await connectionRow(deps.prisma, provider);
  if (!existing) throw new ClientError("NOT_FOUND", "Company provider not found");
  // Deleting the persisted Secret runs the existing remote-secret cleanup workflow. Its
  // FK cascade removes the connection and grants in the same transaction.
  await runAsSystem("remove company provider connection and grants", () =>
    deps.prisma.secret.delete({ where: { id: existing.secretId } }),
  );
  await recordSecurityEvent({
    type: "platform.provider.connection_deleted",
    userId: actorUserId,
    metadata: { provider },
  });
}

export async function setPlatformModelGrant(
  prisma: PrismaClient,
  actorUserId: string,
  input: {
    userId: string;
    provider: string;
    enabled: boolean;
    allowedModelIds: string[];
    countsTowardUserBudget?: boolean;
  },
) {
  const countsTowardUserBudget = input.countsTowardUserBudget ?? true;
  const { provider } = providerDefinition(input.provider);
  const allowedModelIds = [
    ...new Set(input.allowedModelIds.map((id) => id.trim()).filter(Boolean)),
  ];
  if (input.enabled && allowedModelIds.length === 0)
    throw new ClientError("BAD_REQUEST", "Choose at least one model before enabling access");
  const [connection, user] = await runAsSystem("authorize company model grant target", () =>
    Promise.all([
      prisma.platformModelConnection.findUnique({ where: { provider }, select: { id: true } }),
      prisma.user.findUnique({
        where: { id: input.userId },
        select: {
          id: true,
          deactivatedAt: true,
          platformMonitoringAcceptedAt: true,
          platformRole: true,
        },
      }),
    ]),
  );
  if (!connection) throw new ClientError("NOT_FOUND", "Company provider not found");
  if (
    !user ||
    user.deactivatedAt ||
    (!user.platformMonitoringAcceptedAt && user.platformRole !== "owner")
  )
    throw new ClientError(
      "CONFLICT",
      "The account must be active and accept the workspace notice first",
    );
  await runAsSystem("set company provider grant", () =>
    prisma.platformModelGrant.upsert({
      where: { userId_connectionId: { userId: input.userId, connectionId: connection.id } },
      create: {
        userId: input.userId,
        connectionId: connection.id,
        enabled: input.enabled,
        allowedModelIds,
        countsTowardUserBudget,
      },
      update: {
        enabled: input.enabled,
        allowedModelIds,
        countsTowardUserBudget,
      },
      select: {
        id: true,
        userId: true,
        enabled: true,
        allowedModelIds: true,
        countsTowardUserBudget: true,
      },
    }),
  );
  await recordSecurityEvent({
    type: "platform.provider.grant_changed",
    userId: actorUserId,
    metadata: {
      targetId: input.userId,
      provider,
      action: input.enabled ? "enabled" : "updated_disabled",
      countsTowardUserBudget,
      allowedModelCount: allowedModelIds.length,
    },
  });
  const row = await connectionRow(prisma, provider);
  if (!row) throw new ClientError("NOT_FOUND", "Company provider not found");
  return toDto(row);
}
