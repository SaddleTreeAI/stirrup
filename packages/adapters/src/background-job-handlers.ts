import type {
  AgentHomeStore,
  AgentRuntime,
  ArtifactStore,
  BackgroundJobExecution,
  BackgroundJobHandlers,
  BackgroundJobPayloads,
  JobPublisher,
  MediaGenerationProvider,
  PaymentWalletProvider,
  SandboxProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import {
  memoryRetainTurnJob,
  memoryRetainTurnRecoveryJobKey,
  SandboxRateLimitError,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  cancelRunsInTransaction,
  resolvePlatformBotTenantScope,
  runAsSystem,
  runAsTenant,
  runAsTenantWithPlatformBots,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { settleCallRequest } from "./call-request.js";
import type { CloudAgentConnection, UserCloudAgents } from "./cloud-agent-factory.js";
import { pollCloudAgent } from "./cloud-agent-poll.js";
import { expireComputerControl, scheduleComputerControlExpiry } from "./computer-control.js";
import { rateLimitEnds, scheduleComputerSleep, sleepComputerIfIdle } from "./computer-idle.js";
import { performComputerUpdate } from "./computer-update.js";
import { retryConnectionCleanup } from "./connection-cleanup.js";
import type { ConnectorRegistry } from "./connector-registry.js";
import {
  abandonRetainedConversation,
  retainRunConversation,
  settleRetainedConversation,
} from "./conversation-memory.js";
import { retryConversationMemoryPurge } from "./conversation-memory-cleanup.js";
import type { createRunExecutor } from "./executor.js";
import type { ExpoPushProvider } from "./expo-push.js";
import { compactHistory } from "./history-compaction.js";
import { retryMachineCleanup } from "./machine-cleanup.js";
import { pollMediaVideo } from "./media-video-poll.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import type { MessagingDelivery } from "./messaging-delivery.js";
import { pollPurchase } from "./purchase-poll.js";
import { expireRunSecrets } from "./run-secrets-expiry.js";
import { retrySecretCleanup } from "./secret-cleanup.js";
import { expireTaughtSkillTeaching } from "./teaching-session.js";
import type { TeamChat } from "./team-chat.js";

type Tenant = { spaceId: string; userId: string };
type ContinuableRunTenant = Tenant & { id: string; botId: string; taskId: string };
type BotTenant = Tenant & { botId: string; botIds?: string[] };
type CompanyComputerTenant = Tenant & {
  botIds: string[];
  requesterBound?: boolean;
  requireRequester?: boolean;
  legacyUserId?: string;
};

async function cancelComputerUpdateForAccess(
  deps: { prisma: PrismaClient; events: ThreadEvents },
  updateId: string,
  spaceId: string,
  reason: "missing-requester" | "revoked-access",
) {
  const failureReason =
    reason === "missing-requester"
      ? "This queued request has no verified requester. Ask an administrator to submit it again."
      : "The requester no longer has access to every bot using this computer. The update was cancelled.";
  await runAsSystem("cancel a queued computer update after company access changed", async () => {
    await deps.prisma.$transaction(async (tx) => {
      const canceled = await tx.computerUpdate.updateMany({
        where: { id: updateId, status: "queued" },
        data: { status: "failed", failureReason },
      });
      if (canceled.count !== 1) return;
      await tx.computer.updateMany({
        where: { maintenanceId: updateId },
        data: { maintenanceId: null },
      });
    });
  });
  await deps.events.publishSpaceChange?.(spaceId, "computerUpdates");
}

/**
 * A job that acts for one run, routine, computer, skill, thread, cloud agent or purchase runs
 * as that row's tenant, so row-level security keeps it, and every tool it runs, in
 * the owner's Space even where a query forgets to filter. Normally the owner comes from one
 * narrow system read. Server-created cleanup intent can capture that tenant before deletion.
 */
function asOwner<Key, P extends Key>(
  owner: (payload: Key) => Promise<Tenant | null>,
  handler: (
    payload: P,
    execution: BackgroundJobExecution | undefined,
    tenant: Tenant,
  ) => Promise<void>,
): (payload: P, execution?: BackgroundJobExecution) => Promise<void> {
  return async (payload, execution) => {
    const tenant = await runAsSystem("find the tenant a background job acts for", () =>
      owner(payload),
    );
    if (tenant) await runAsTenant(tenant, () => handler(payload, execution, tenant));
  };
}

/** Rechecks a company bot grant at each durable run continuation before any tool or model work. */
function asCompanyBotRunOwner<Key extends { runId: string }, P extends Key>(
  prisma: PrismaClient,
  owner: (payload: Key) => Promise<ContinuableRunTenant | null>,
  handler: (
    payload: P,
    execution: BackgroundJobExecution | undefined,
    tenant: Tenant,
  ) => Promise<void>,
  events: ThreadEvents,
): (payload: P, execution?: BackgroundJobExecution) => Promise<void> {
  return async (payload, execution) => {
    const tenant = await runAsSystem("find the tenant a run continuation acts for", () =>
      owner(payload),
    );
    if (!tenant) return;
    const resolution = await resolvePlatformBotTenantScope(prisma, {
      spaceId: tenant.spaceId,
      userId: tenant.userId,
      botId: tenant.botId,
      botIds: [tenant.botId],
      requiredPermission: "use",
    });
    if (resolution.kind === "not-company") {
      await runAsTenant(tenant, () => handler(payload, execution, tenant));
      return;
    }
    if (resolution.kind === "granted") {
      await runAsTenantWithPlatformBots(resolution.scope, () =>
        handler(payload, execution, tenant),
      );
      return;
    }

    // Access may have been revoked after the message queued this run. Settle it without executing
    // another model/tool pass, so a denied job doesn't leave a permanently queued run behind.
    await runAsSystem("cancel a queued company bot run after access was revoked", async () => {
      await prisma.$transaction(async (tx) => {
        await cancelRunsInTransaction(tx, [tenant], new Date());
      });
    });
    await events.publishSpaceChange?.(tenant.spaceId, "runs");
  };
}

/** Applies the live bot grant to every bot-linked durable job before it reads or writes content. */
function asCompanyBotOwner<Key, P extends Key>(
  prisma: PrismaClient,
  owner: (payload: Key) => Promise<BotTenant | null>,
  handler: (
    payload: P,
    execution: BackgroundJobExecution | undefined,
    tenant: Tenant,
  ) => Promise<void>,
): (payload: P, execution?: BackgroundJobExecution) => Promise<void> {
  return async (payload, execution) => {
    const tenant = await runAsSystem("find the bot tenant a background job acts for", () =>
      owner(payload),
    );
    if (!tenant) return;
    const resolution = await resolvePlatformBotTenantScope(prisma, {
      spaceId: tenant.spaceId,
      userId: tenant.userId,
      botId: tenant.botId,
      botIds: tenant.botIds ?? [tenant.botId],
      requiredPermission: "use",
    });
    if (resolution.kind === "not-company") {
      await runAsTenant(tenant, () => handler(payload, execution, tenant));
    } else if (resolution.kind === "granted") {
      await runAsTenantWithPlatformBots(resolution.scope, () =>
        handler(payload, execution, tenant),
      );
    }
  };
}

/** Company computer maintenance requires permission over every bot attached to the machine. */
function asCompanyComputerOwner<Key, P extends Key>(
  prisma: PrismaClient,
  owner: (payload: Key) => Promise<CompanyComputerTenant | null>,
  requiredPermission: "use" | "manage",
  handler: (
    payload: P,
    execution: BackgroundJobExecution | undefined,
    tenant: Tenant,
  ) => Promise<void>,
  denied?: (
    payload: P,
    tenant: CompanyComputerTenant,
    reason: "missing-requester" | "revoked-access",
  ) => Promise<void>,
): (payload: P, execution?: BackgroundJobExecution) => Promise<void> {
  return async (payload, execution) => {
    const tenant = await runAsSystem("find the company computer tenant for a lifecycle job", () =>
      owner(payload),
    );
    if (!tenant) return;
    const [botId, ...botIds] = tenant.botIds;
    const resolution = await resolvePlatformBotTenantScope(prisma, {
      spaceId: tenant.spaceId,
      userId: tenant.userId,
      botId: botId ?? "",
      botIds,
      requiredPermission,
    });
    const deniedReason =
      tenant.requireRequester && !tenant.requesterBound
        ? "missing-requester"
        : resolution.kind === "denied"
          ? "revoked-access"
          : null;
    if (resolution.kind !== "not-company" && deniedReason) {
      await denied?.(payload, tenant, deniedReason);
      return;
    }
    if (resolution.kind === "not-company") {
      const legacyTenant = {
        spaceId: tenant.spaceId,
        userId: tenant.requesterBound ? tenant.userId : (tenant.legacyUserId ?? tenant.userId),
      };
      await runAsTenant(legacyTenant, () => handler(payload, execution, legacyTenant));
    } else if (resolution.kind === "granted") {
      await runAsTenantWithPlatformBots(resolution.scope, () =>
        handler(payload, execution, tenant),
      );
    }
  };
}

const OWNER = { spaceId: true, userId: true } as const;
const CONTINUABLE_RUN = {
  id: true,
  spaceId: true,
  userId: true,
  botId: true,
  taskId: true,
} as const;
const CONTROL_EXPIRE_RETRY_MS = 30_000;
/**
 * How long to wait before asking again whether the memory provider stored a turn: 5 s, doubling
 * up to 10 min. 150 checks wait about 24 h in all, long enough for a backed-up provider.
 */
const RETAIN_TURN_FIRST_CHECK_MS = 5_000;
const RETAIN_TURN_MAX_CHECK_MS = 10 * 60_000;
const MAX_RETAIN_TURN_CHECKS = 150;

export function createBackgroundJobHandlers(deps: {
  executor: ReturnType<typeof createRunExecutor>;
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  artifacts: ArtifactStore;
  jobs: JobPublisher;
  events: ThreadEvents;
  workerId: string;
  runtime: AgentRuntime;
  secretStore: SecretStore;
  memoryProviders: MemoryProviderResolver;
  deploymentModelKey?: string;
  deploymentModelConfigured?: boolean;
  messagingDelivery?: MessagingDelivery;
  teamChat?: TeamChat;
  connectors?: Pick<ConnectorRegistry, "managed">;
  cloudAgent?: CloudAgentConnection | null;
  userCloudAgents?: UserCloudAgents;
  paymentWallet?: PaymentWalletProvider | null;
  notifications?: ExpoPushProvider;
  mediaGeneration?: MediaGenerationProvider;
  maxUploadSizeBytes?: number;
}): BackgroundJobHandlers {
  const delivery = deps.messagingDelivery;
  const cleanupDeps = { prisma: deps.prisma, secrets: deps.secretStore };
  const run = ({ runId }: { runId: string }) =>
    deps.prisma.run.findUnique({ where: { id: runId }, select: CONTINUABLE_RUN });
  const routine = ({ routineId }: { routineId: string }) =>
    deps.prisma.routine.findUnique({
      where: { id: routineId },
      select: { ...OWNER, botId: true },
    });
  const computer = ({ computerId }: { computerId: string }) =>
    deps.prisma.computer.findUnique({
      where: { id: computerId },
      select: { ...OWNER, bots: { where: { archivedAt: null }, select: { id: true } } },
    });
  const thread = ({ threadId }: { threadId: string }) =>
    deps.prisma.thread.findUnique({
      where: { id: threadId },
      select: {
        ...OWNER,
        botId: true,
        group: { select: { members: { select: { botId: true } } } },
      },
    });
  const threadBotTenant = async ({ threadId }: { threadId: string }): Promise<BotTenant | null> => {
    const row = await thread({ threadId });
    if (!row) return null;
    const botIds = row.botId ? [row.botId] : (row.group?.members.map(({ botId }) => botId) ?? []);
    if (!botIds.length) return null;
    return { spaceId: row.spaceId, userId: row.userId, botId: botIds[0]!, botIds };
  };
  const skill = ({ skillId }: { skillId: string }) =>
    deps.prisma.taughtSkill.findUnique({
      where: { id: skillId },
      select: { ...OWNER, botId: true },
    });
  const cloudAgent = ({ agentId }: { agentId: string }) =>
    deps.prisma.cloudAgent.findUnique({ where: { id: agentId }, select: OWNER });
  const purchase = ({ purchaseId }: { purchaseId: string }) =>
    deps.prisma.purchase.findUnique({ where: { id: purchaseId }, select: OWNER });
  const mediaJob = async ({ jobId }: { jobId: string }) =>
    (
      await deps.prisma.externalEffect.findUnique({
        where: { id: jobId },
        select: { run: { select: OWNER } },
      })
    )?.run ?? null;
  const computerTenant = async (
    row: Awaited<ReturnType<typeof computer>>,
  ): Promise<CompanyComputerTenant | null> =>
    row
      ? {
          spaceId: row.spaceId,
          userId: row.userId,
          botIds: row.bots?.map(({ id }) => id) ?? [],
        }
      : null;
  const updatedComputer = async ({ updateId }: { updateId: string }) => {
    const row = await deps.prisma.computerUpdate.findUnique({
      where: { id: updateId },
      select: {
        requestedByUserId: true,
        computer: {
          select: { ...OWNER, bots: { where: { archivedAt: null }, select: { id: true } } },
        },
      },
    });
    if (!row?.computer) return null;
    const tenant = await computerTenant(row.computer);
    if (!tenant) return null;
    return {
      ...tenant,
      userId: row.requestedByUserId ?? row.computer.userId,
      legacyUserId: row.computer.userId,
      requesterBound: row.requestedByUserId !== null,
      requireRequester: true,
    };
  };
  const computerJobTenant = async (payload: { computerId: string }) =>
    computerTenant(await computer(payload));

  return {
    "run.continue": asCompanyBotRunOwner(
      deps.prisma,
      run,
      async (payload, execution, { spaceId }) => {
        try {
          if (execution)
            await deps.executor.continueRun(payload.runId, deps.workerId, execution.onRunStarted);
          else await deps.executor.continueRun(payload.runId, deps.workerId);
        } finally {
          // Whatever this turn did to its run (waited, paused, requeued, ended), apps read it again.
          await deps.events.publishSpaceChange?.(spaceId, "runs");
        }
        // The process that ran the turn sends what it said straight away. An ended run's reply
        // job, scheduled with its status, covers a failure here; it never fails the run.
        await delivery?.deliverRun(payload.runId).catch((error) => {
          delivery.reportFailure("messaging reply delivery error", error);
        });
      },
      deps.events,
    ),
    "messaging.send": async ({ outboundId }, _execution, attempt) => {
      await delivery?.sendJob(outboundId, attempt);
    },
    "messaging.reply": async ({ runId }) => {
      await delivery?.deliverRun(runId);
    },
    "secret.cleanup": async (cleanup) => {
      await retrySecretCleanup(cleanupDeps, cleanup);
    },
    "connection.cleanup": asOwner(
      async (payload: BackgroundJobPayloads["connection.cleanup"]) => payload,
      async (payload: BackgroundJobPayloads["connection.cleanup"]) => {
        // Fail rather than finish, so the queue keeps the job for a process that has connectors.
        if (!deps.connectors) throw new Error("connection cleanup has no connector registry");
        await retryConnectionCleanup(
          { prisma: deps.prisma, connectors: deps.connectors, jobs: deps.jobs },
          payload,
        );
      },
    ),
    // The machine belongs to no Space: nothing stores it.
    "computer.machine-cleanup": async (machine, _execution, attempt) => {
      await retryMachineCleanup(deps, machine, attempt);
    },
    // The previous release's jobs, drained by this one. Jobs under this name can stay queued
    // across releases, so it goes only once none are left.
    "messaging.credential-cleanup": async ({ installationId, ref }) => {
      await retrySecretCleanup(cleanupDeps, {
        kind: "messaging_installation",
        recordId: installationId,
        ref,
      });
    },
    "messaging.deliver": async ({ runId }) => {
      if (runId) await delivery?.deliverRun(runId);
      await delivery?.drainAll();
    },
    "messaging.progress": async ({ runId }) => {
      await delivery?.deliverRun(runId, { progress: true });
    },
    "team_chat.engage": async ({ externalMessageId }) => {
      await deps.teamChat?.engageJob(externalMessageId);
    },
    "team_chat.ambient": async ({ conversationId }) => {
      await deps.teamChat?.ambientJob(conversationId);
    },
    "routine.wakeup": asCompanyBotOwner(
      deps.prisma,
      routine,
      async (payload, _execution, { spaceId }) => {
        try {
          await deps.executor.wakeRoutine(payload.routineId, payload.scheduledFor);
        } finally {
          // A wake moves the routine's next run, or pauses it, and may queue or coalesce runs.
          await deps.events.publishSpaceChange?.(spaceId, "routines");
          await deps.events.publishSpaceChange?.(spaceId, "runs");
        }
      },
    ),
    "routine.retry": asCompanyBotOwner(
      deps.prisma,
      run,
      async (payload, _execution, { spaceId }) => {
        try {
          await deps.executor.retryRoutineRun(payload.runId);
        } finally {
          await deps.events.publishSpaceChange?.(spaceId, "runs");
        }
      },
    ),
    "computer.update": asCompanyComputerOwner(
      deps.prisma,
      updatedComputer,
      "manage",
      async ({ updateId }) => {
        await performComputerUpdate(deps, updateId);
      },
      async ({ updateId }, tenant, reason) => {
        await cancelComputerUpdateForAccess(deps, updateId, tenant.spaceId, reason);
      },
    ),
    "computer.sleep": asCompanyComputerOwner(
      deps.prisma,
      computerJobTenant,
      "use",
      async (payload) => {
        await sleepComputerIfIdle(deps, payload.computerId);
      },
    ),
    "computer.control-expire": asCompanyComputerOwner(
      deps.prisma,
      computerJobTenant,
      "use",
      async ({ computerId, leaseId }) => {
        try {
          if (await expireComputerControl(deps, computerId, leaseId)) {
            scheduleComputerSleep(deps.jobs, computerId);
          }
        } catch (error) {
          // Input is already denied and the lease kept, so a provider outage only delays the release.
          if (
            !(error instanceof SandboxUnresponsiveError) &&
            !(error instanceof SandboxUnavailableError) &&
            !(error instanceof SandboxRateLimitError)
          )
            throw error;
          getLogger().warn("computer.control_expire_deferred", {
            "computer.id": computerId,
            error,
          });
          await scheduleComputerControlExpiry(
            deps.jobs,
            computerId,
            leaseId,
            rateLimitEnds(error) ?? new Date(Date.now() + CONTROL_EXPIRE_RETRY_MS),
          );
        }
      },
    ),
    "skill.teaching-expire": asCompanyBotOwner(deps.prisma, skill, async (payload) => {
      await expireTaughtSkillTeaching(deps, payload.skillId);
    }),
    "run.forget-secrets": asCompanyBotOwner(deps.prisma, run, async ({ runId }) => {
      await expireRunSecrets({ ...deps, now: new Date() }, runId);
    }),
    "call.expire": asCompanyBotOwner<{ threadId: string }, BackgroundJobPayloads["call.expire"]>(
      deps.prisma,
      threadBotTenant,
      async (payload) => {
        await settleCallRequest(deps, { ...payload, from: ["ringing"], status: "missed" });
      },
    ),
    "cloud_agent.poll": asOwner(cloudAgent, async (payload) => {
      await pollCloudAgent(
        {
          prisma: deps.prisma,
          jobs: deps.jobs,
          events: deps.events,
          cloudAgent: deps.cloudAgent,
          userCloudAgents: deps.userCloudAgents,
        },
        payload,
      );
    }),
    "purchase.poll": asOwner(purchase, async (payload) => {
      await pollPurchase(
        {
          prisma: deps.prisma,
          secretStore: deps.secretStore,
          jobs: deps.jobs,
          paymentWallet: deps.paymentWallet,
        },
        payload,
      );
    }),
    "media.poll": asOwner(mediaJob, async (payload) => {
      await pollMediaVideo(deps, payload);
    }),
    // A receipt belongs to a device's push token, not to a Space.
    "push.receipt": async (payload) => {
      await runAsSystem("check a push receipt", () => deps.notifications?.checkReceipt(payload));
    },
    "history.compact": asCompanyBotOwner<
      { threadId: string; userId?: string },
      BackgroundJobPayloads["history.compact"]
    >(
      deps.prisma,
      async (payload) => {
        const row = await threadBotTenant(payload);
        return row ? { ...row, userId: payload.userId ?? row.userId } : null;
      },
      async (payload) => {
        // Retrieval policies use stored context without paid message-count compaction.
        // Skip legacy backlog work after a policy change.
        if (deps.executor.contextStrategy && deps.executor.contextStrategy !== "current") return;
        await compactHistory(
          {
            prisma: deps.prisma,
            runtime: deps.runtime,
            jobs: deps.jobs,
            memoryProviders: deps.memoryProviders,
            deploymentModelKey: deps.deploymentModelKey,
            deploymentModelConfigured: deps.deploymentModelConfigured,
            ...(deps.executor.resolveModel ? { resolveModel: deps.executor.resolveModel } : {}),
          },
          payload.threadId,
          payload.userId,
        );
      },
    ),
    "memory.purge-history": asCompanyBotOwner(
      deps.prisma,
      async (payload: BackgroundJobPayloads["memory.purge-history"]) => payload,
      async (payload) => retryConversationMemoryPurge(deps, payload),
    ),
    "memory.retain-turn": asCompanyBotOwner(
      deps.prisma,
      async (payload: BackgroundJobPayloads["memory.retain-turn"]) =>
        // Source was captured from the run before submission; group deletion may remove that row.
        payload.pending ? payload.pending.source : run(payload),
      async (payload) => {
        const memory = {
          prisma: deps.prisma,
          memoryProviders: deps.memoryProviders,
          jobs: deps.jobs,
        };
        let next: NonNullable<BackgroundJobPayloads["memory.retain-turn"]["pending"]>;
        if (!payload.pending) {
          const { pending } = await retainRunConversation(
            memory,
            payload.runId,
            payload.messageIds,
          );
          if (!pending) return;
          next = { ...pending, checks: 0 };
        } else {
          // Never rebuild the turn: a clear may have deleted its messages meanwhile.
          const { settled } = await settleRetainedConversation(
            memory,
            payload.runId,
            payload.pending,
          ).catch((error) => {
            // A failed status check or post-clear purge uses the same bounded backoff.
            getLogger().error("memory.retain-turn settlement failed", error);
            return { settled: false };
          });
          if (settled) return;
          next = { ...payload.pending, checks: payload.pending.checks + 1 };
          if (next.checks >= MAX_RETAIN_TURN_CHECKS) {
            getLogger().warn(
              "memory.retain-turn gave up waiting for the provider to store the turn",
              {
                "run.id": payload.runId,
              },
            );
            await abandonRetainedConversation(memory, payload.runId, next);
            return;
          }
        }
        // Not settled yet: check again later instead of holding a worker.
        await deps.jobs.enqueue(
          memoryRetainTurnJob(payload.runId, payload.messageIds, {
            pending: next,
            availableAt: new Date(
              Date.now() +
                Math.min(RETAIN_TURN_FIRST_CHECK_MS * 2 ** next.checks, RETAIN_TURN_MAX_CHECK_MS),
            ),
          }),
        );
        if (!payload.pending) {
          // Cancel only after the confirmed handoff is durable. An already running recovery
          // may requeue itself, but its separate key cannot erase the token and its budget ends.
          await deps.jobs.cancel(memoryRetainTurnRecoveryJobKey(payload.runId)).catch((error) => {
            getLogger().error("memory.retain-turn recovery cancellation failed", error);
          });
        }
      },
    ),
  };
}
