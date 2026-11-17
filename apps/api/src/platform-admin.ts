import { createHash, randomBytes } from "node:crypto";
import type {
  PlatformAdminOverview,
  PlatformAdminUser,
  PlatformInvite,
  PlatformRole,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { recordPlatformBudgetThresholdAlerts, recordSecurityEvent, runAsSystem } from "@rakazo/db";
import type { RouterDeps } from "./router.js";

type PlatformPrisma = Pick<
  PrismaClient,
  | "user"
  | "platformInvite"
  | "platformModelBudgetBucket"
  | "platformModelBudgetAlert"
  | "usageRecord"
  | "deploymentSettings"
  | "$transaction"
>;
type PlatformRolePrisma = Pick<PrismaClient, "user" | "deploymentSettings">;
const MICROS_PER_DOLLAR = 1_000_000n;

export function platformRoleAtLeast(role: string | null | undefined, required: "admin" | "owner") {
  return required === "owner" ? role === "owner" : role === "owner" || role === "admin";
}

export function isEnrolledPlatformAccount(user: {
  platformRole: string;
  platformMonitoringAcceptedAt: Date | null;
  emailVerified: boolean;
  deactivatedAt: Date | null;
}): boolean {
  return (
    !user.deactivatedAt &&
    user.emailVerified &&
    (user.platformRole === "owner" ||
      ((user.platformRole === "admin" || user.platformRole === "member") &&
        user.platformMonitoringAcceptedAt !== null))
  );
}

export function requireCanDeactivatePlatformAccount(input: {
  actorUserId: string;
  actorRole: PlatformRole;
  targetUserId: string;
  targetRole: PlatformRole;
}): void {
  if (input.actorUserId === input.targetUserId)
    throw new ClientError("FORBIDDEN", "You cannot deactivate your own account");
  if (input.targetRole === "owner")
    throw new ClientError("FORBIDDEN", "Platform owners cannot be deactivated here");
  if (input.actorRole !== "owner" && input.targetRole !== "member")
    throw new ClientError("FORBIDDEN", "Only an owner can deactivate administrators");
}

export async function requirePlatformRole(
  prisma: PlatformRolePrisma,
  userId: string,
  required: "admin" | "owner" = "admin",
): Promise<PlatformRole> {
  const role = await runAsSystem("authorize platform administration", async () => {
    const [user, settings] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          platformRole: true,
          platformMonitoringAcceptedAt: true,
          emailVerified: true,
          deactivatedAt: true,
        },
      }),
      prisma.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { platformMode: true },
      }),
    ]);
    return settings?.platformMode && user && isEnrolledPlatformAccount(user)
      ? user.platformRole
      : null;
  });
  if (!platformRoleAtLeast(role, required)) throw new ClientError("FORBIDDEN", "Forbidden");
  return role as PlatformRole;
}

/** Owner-only content inspection gate. Call this immediately before an audited read. */
export async function authorizePlatformInspection(
  prisma: PlatformRolePrisma,
  actorUserId: string,
  targetUserId: string,
  area: "account" | "usage" | "bot-content",
): Promise<void> {
  await requirePlatformRole(prisma, actorUserId, "owner");
  await runAsSystem("audit platform account inspection", async () => {
    const target = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        platformRole: true,
        platformMonitoringAcceptedAt: true,
        emailVerified: true,
      },
    });
    if (!target) throw new ClientError("NOT_FOUND", "Account not found");
  });
  await recordSecurityEvent({
    type: "platform.admin.inspection",
    userId: actorUserId,
    metadata: { targetId: targetUserId, area },
  });
}

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function dollarsFromMicros(value: bigint): number {
  return Number(value) / Number(MICROS_PER_DOLLAR);
}

type UsageGroup = {
  userId: string;
  _sum: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  _count: { _all: number; inputTokens: number; outputTokens: number; costUsd: number };
};

type CompanyBudget = { chargedMicros: bigint; reservedMicros: bigint };

async function monthlyUsage(prisma: PlatformPrisma, userIds: string[]) {
  const where = { createdAt: { gte: monthStart() }, userId: { in: userIds } };
  const [groups, totals, totalCount] = await Promise.all([
    prisma.usageRecord.groupBy({
      by: ["userId"],
      where,
      _sum: { inputTokens: true, outputTokens: true, costUsd: true },
      _count: { _all: true, inputTokens: true, outputTokens: true, costUsd: true },
    }),
    prisma.usageRecord.aggregate({
      where,
      _sum: { inputTokens: true, outputTokens: true, costUsd: true },
      _count: { _all: true, inputTokens: true, outputTokens: true, costUsd: true },
    }),
    prisma.usageRecord.count({ where }),
  ]);
  return {
    groups: new Map(groups.map((group) => [group.userId, group])),
    totals: {
      monthToDateCostUsd:
        totals._count.costUsd === totals._count._all ? (totals._sum.costUsd ?? 0) : null,
      monthToDateInputTokens:
        totals._count.inputTokens === totals._count._all ? (totals._sum.inputTokens ?? 0) : null,
      monthToDateOutputTokens:
        totals._count.outputTokens === totals._count._all ? (totals._sum.outputTokens ?? 0) : null,
      monthToDateCalls: totalCount,
    },
  };
}

export async function platformAdminOverview(
  prisma: PlatformPrisma,
): Promise<PlatformAdminOverview> {
  return runAsSystem("read platform administration overview", async () => {
    const accounts = await prisma.user.findMany({
      select: { id: true, deactivatedAt: true },
    });
    const [pendingInvites, usage] = await Promise.all([
      prisma.platformInvite.count({
        where: { kind: "invite", acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
      monthlyUsage(
        prisma,
        accounts.map(({ id }) => id),
      ),
    ]);
    return {
      users: accounts.length,
      activeUsers: accounts.filter((user) => !user.deactivatedAt).length,
      pendingInvites,
      ...usage.totals,
    };
  });
}

function userDto(
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    platformMonitoringAcceptedAt: Date | null;
    platformRole: string;
    deactivatedAt: Date | null;
    createdAt: Date;
    platformMonthlyBudgetMicros: bigint;
  },
  usage?: UsageGroup,
  companyBudget?: CompanyBudget,
  companyBudgetAlerts: PlatformAdminUser["companyBudgetAlerts"] = [],
): PlatformAdminUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    monitoringAccepted: user.platformMonitoringAcceptedAt !== null,
    role: user.platformRole as PlatformRole,
    active: !user.deactivatedAt,
    pendingActivation: false,
    activationInviteId: null,
    activationExpiresAt: null,
    createdAt: user.createdAt.toISOString(),
    monthlyBudgetUsd: dollarsFromMicros(user.platformMonthlyBudgetMicros),
    companyBudgetChargedUsd: dollarsFromMicros(companyBudget?.chargedMicros ?? 0n),
    companyBudgetReservedUsd: dollarsFromMicros(companyBudget?.reservedMicros ?? 0n),
    companyBudgetAlerts,
    monthToDateCostUsd:
      usage && usage._count.costUsd !== usage._count._all ? null : (usage?._sum.costUsd ?? 0),
    monthToDateInputTokens:
      usage && usage._count.inputTokens !== usage._count._all
        ? null
        : (usage?._sum.inputTokens ?? 0),
    monthToDateOutputTokens:
      usage && usage._count.outputTokens !== usage._count._all
        ? null
        : (usage?._sum.outputTokens ?? 0),
    monthToDateCalls: usage?._count._all ?? 0,
  };
}

export async function listPlatformUsers(
  prisma: PlatformPrisma,
  actorUserId: string,
): Promise<PlatformAdminUser[]> {
  await requirePlatformRole(prisma, actorUserId, "admin");
  const users = await runAsSystem("list platform accounts and usage", async () => {
    const currentMonthStart = monthStart();
    const accounts = await prisma.user.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        email: true,
        name: true,
        emailVerified: true,
        platformMonitoringAcceptedAt: true,
        platformRole: true,
        deactivatedAt: true,
        createdAt: true,
        platformMonthlyBudgetMicros: true,
      },
    });
    const [usage, companyBudgets, alerts, provisions] = await Promise.all([
      monthlyUsage(
        prisma,
        accounts.map(({ id }) => id),
      ),
      prisma.platformModelBudgetBucket.findMany({
        where: { monthStart: currentMonthStart },
        select: { userId: true, chargedMicros: true, reservedMicros: true },
      }),
      prisma.platformModelBudgetAlert.findMany({
        where: {
          userId: { in: accounts.map(({ id }) => id) },
          monthStart: currentMonthStart,
        },
        orderBy: { thresholdPercent: "asc" },
        select: { userId: true, thresholdPercent: true, createdAt: true, sentAt: true },
      }),
      prisma.platformInvite.findMany({
        where: { kind: "provision", acceptedAt: null, revokedAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, email: true, name: true, role: true, createdAt: true, expiresAt: true },
      }),
    ]);
    const budgets = new Map(companyBudgets.map((bucket) => [bucket.userId, bucket]));
    const userAlerts = new Map<string, PlatformAdminUser["companyBudgetAlerts"]>();
    for (const alert of alerts) {
      const list = userAlerts.get(alert.userId) ?? [];
      list.push({
        thresholdPercent: alert.thresholdPercent as 80 | 100,
        createdAt: alert.createdAt.toISOString(),
        sentAt: alert.sentAt?.toISOString() ?? null,
      });
      userAlerts.set(alert.userId, list);
    }
    const actualUsers = accounts.map((user) =>
      userDto(user, usage.groups.get(user.id), budgets.get(user.id), userAlerts.get(user.id)),
    );
    const pendingUsers: PlatformAdminUser[] = provisions.map((provision) => ({
      id: `pending:${provision.id}`,
      email: provision.email,
      name: provision.name,
      emailVerified: false,
      monitoringAccepted: false,
      role: provision.role as PlatformRole,
      active: false,
      pendingActivation: true,
      activationInviteId: provision.id,
      activationExpiresAt: provision.expiresAt.toISOString(),
      createdAt: provision.createdAt.toISOString(),
      monthlyBudgetUsd: 100,
      companyBudgetChargedUsd: 0,
      companyBudgetReservedUsd: 0,
      companyBudgetAlerts: [],
      monthToDateCostUsd: null,
      monthToDateInputTokens: null,
      monthToDateOutputTokens: null,
      monthToDateCalls: 0,
    }));
    return [...actualUsers, ...pendingUsers];
  });
  await recordSecurityEvent({
    type: "platform.admin.inspection",
    userId: actorUserId,
    metadata: { targetId: "all", area: "usage" },
  });
  return users;
}

function inviteDto(invite: {
  id: string;
  kind: string;
  email: string;
  name: string;
  role: string;
  expiresAt: Date;
  createdAt: Date;
}): PlatformInvite {
  return {
    id: invite.id,
    kind: invite.kind as "invite" | "provision",
    email: invite.email,
    name: invite.name,
    role: invite.role as Exclude<PlatformRole, "owner">,
    expiresAt: invite.expiresAt.toISOString(),
    createdAt: invite.createdAt.toISOString(),
  };
}

export async function createPlatformInvite(
  deps: Pick<RouterDeps, "prisma" | "email" | "env">,
  actorUserId: string,
  input: { email: string; name: string; role: Exclude<PlatformRole, "owner"> },
  kind: "invite" | "provision" = "invite",
) {
  const actorRole = await requirePlatformRole(deps.prisma, actorUserId);
  if (
    (kind === "provision" && actorRole !== "owner") ||
    (actorRole !== "owner" && input.role !== "member")
  )
    throw new ClientError("FORBIDDEN", "Only an owner can invite an administrator");
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const invite = await runAsSystem("create platform account invitation", async () => {
    const [existing, pending, deployment] = await Promise.all([
      deps.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } }),
      deps.prisma.platformInvite.findFirst({
        where: {
          email: input.email,
          acceptedAt: null,
          revokedAt: null,
          OR: [{ kind: "provision" }, { expiresAt: { gt: now } }],
        },
        select: { id: true },
      }),
      deps.prisma.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { platformMode: true },
      }),
    ]);
    if (!deployment?.platformMode)
      throw new ClientError("NOT_FOUND", "Platform administration is disabled");
    if (existing) throw new ClientError("CONFLICT", "An account already uses that email");
    if (pending)
      throw new ClientError("CONFLICT", "A pending account link already uses that email");
    const created = await deps.prisma.platformInvite.create({
      data: {
        email: input.email,
        name: input.name,
        kind,
        role: input.role,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        createdByUserId: actorUserId,
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    return created;
  });
  const url = new URL("/invite", deps.env.webOrigin);
  url.searchParams.set("platformToken", token);
  if (deps.email) {
    try {
      await deps.email.send({
        to: invite.email,
        subject:
          kind === "provision"
            ? "Your Stirrup account activation"
            : "Your Stirrup account invitation",
        text:
          kind === "provision"
            ? `Your Stirrup account is ready to activate. Set your password and accept the workspace notice within 7 days: ${url.href}`
            : `You were invited to join a Stirrup workspace. Create your account within 7 days: ${url.href}`,
      });
    } catch (error) {
      await runAsSystem("revoke undelivered platform invitation", () =>
        deps.prisma.platformInvite.updateMany({
          where: { id: invite.id, acceptedAt: null, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      );
      throw error;
    }
  }
  await recordSecurityEvent({
    type: "platform.account.invited",
    userId: actorUserId,
    metadata: { targetId: invite.id, role: invite.role },
  });
  return { invite: inviteDto(invite), url: url.href };
}

export async function previewPlatformInvite(prisma: PlatformPrisma, token: string) {
  return runAsSystem("preview platform invitation", async () => {
    const settings = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { platformMode: true },
    });
    const invite = settings?.platformMode
      ? await prisma.platformInvite.findFirst({
          where: {
            tokenHash: createHash("sha256").update(token).digest("hex"),
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { email: true, name: true, expiresAt: true },
        })
      : null;
    if (!invite) throw new ClientError("NOT_FOUND", "Invitation is invalid or expired");
    return {
      email: invite.email,
      name: invite.name,
      expiresAt: invite.expiresAt.toISOString(),
    };
  });
}

export async function listPlatformInvites(prisma: PlatformPrisma): Promise<PlatformInvite[]> {
  return runAsSystem("list platform invitations", async () => {
    const invites = await prisma.platformInvite.findMany({
      where: { kind: "invite", acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    return invites.map(inviteDto);
  });
}

export async function revokePlatformInvite(prisma: PlatformPrisma, inviteId: string) {
  return runAsSystem("revoke platform invitation", async () => {
    const result = await prisma.platformInvite.updateMany({
      where: { id: inviteId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!result.count) throw new ClientError("NOT_FOUND", "Invitation not found");
  });
}

export async function setPlatformProvisionRole(
  prisma: PlatformPrisma,
  actorUserId: string,
  inviteId: string,
  role: Exclude<PlatformRole, "owner">,
): Promise<void> {
  await requirePlatformRole(prisma, actorUserId, "owner");
  const result = await runAsSystem("change pending platform account role", () =>
    prisma.platformInvite.updateMany({
      where: { id: inviteId, kind: "provision", acceptedAt: null, revokedAt: null },
      data: { role },
    }),
  );
  if (!result.count) throw new ClientError("NOT_FOUND", "Pending account not found");
  await recordSecurityEvent({
    type: "platform.account.role_changed",
    userId: actorUserId,
    metadata: { targetId: inviteId, role, pending: true },
  });
}

/** Rotates an activation link; the old bearer token stops working immediately. */
export async function resendPlatformProvision(
  deps: Pick<RouterDeps, "prisma" | "email" | "env">,
  actorUserId: string,
  inviteId: string,
): Promise<{ url: string; expiresAt: string }> {
  await requirePlatformRole(deps.prisma, actorUserId, "owner");
  const provision = await runAsSystem("load pending platform account for activation resend", () =>
    deps.prisma.platformInvite.findFirst({
      where: { id: inviteId, kind: "provision", acceptedAt: null, revokedAt: null },
      select: { id: true, email: true, name: true, role: true, tokenHash: true, expiresAt: true },
    }),
  );
  if (!provision) throw new ClientError("NOT_FOUND", "Pending account not found");
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const changed = await runAsSystem("rotate pending platform account activation link", () =>
    deps.prisma.platformInvite.updateMany({
      where: {
        id: inviteId,
        kind: "provision",
        acceptedAt: null,
        revokedAt: null,
        tokenHash: provision.tokenHash,
      },
      data: { tokenHash, expiresAt },
    }),
  );
  if (!changed.count)
    throw new ClientError("CONFLICT", "Pending account changed; reload and retry");
  const url = new URL("/invite", deps.env.webOrigin);
  url.searchParams.set("platformToken", token);
  try {
    await deps.email?.send({
      to: provision.email,
      subject: "Your Stirrup account activation",
      text: `Your Stirrup account is ready to activate. Set your password and accept the workspace notice within 7 days: ${url.href}`,
    });
  } catch (error) {
    await runAsSystem("restore activation after an undelivered email", () =>
      deps.prisma.platformInvite.updateMany({
        where: { id: inviteId, tokenHash },
        data: { tokenHash: provision.tokenHash, expiresAt: provision.expiresAt },
      }),
    );
    throw error;
  }
  await recordSecurityEvent({
    type: "platform.account.activation_resent",
    userId: actorUserId,
    metadata: { targetId: inviteId },
  });
  return { url: url.href, expiresAt: expiresAt.toISOString() };
}

export async function setPlatformRole(
  prisma: PlatformPrisma,
  actorUserId: string,
  userId: string,
  role: PlatformRole,
): Promise<PlatformAdminUser> {
  await requirePlatformRole(prisma, actorUserId, "owner");
  return runAsSystem("change platform account role", () =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rakazo:platform-owner'))`;
      const [actor, target, owners] = await Promise.all([
        tx.user.findUnique({ where: { id: actorUserId }, select: { platformRole: true } }),
        tx.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            platformRole: true,
            platformMonitoringAcceptedAt: true,
            emailVerified: true,
            deactivatedAt: true,
          },
        }),
        tx.user.count({ where: { platformRole: "owner", deactivatedAt: null } }),
      ]);
      if (actor?.platformRole !== "owner") throw new ClientError("FORBIDDEN", "Forbidden");
      if (!target) throw new ClientError("NOT_FOUND", "Account not found");
      if (target.platformRole === "owner" && role !== "owner" && owners <= 1)
        throw new ClientError("CONFLICT", "The last active owner cannot be demoted");
      const updated = await tx.user.update({
        where: { id: userId },
        data: { platformRole: role },
        select: {
          id: true,
          email: true,
          name: true,
          emailVerified: true,
          platformMonitoringAcceptedAt: true,
          platformRole: true,
          deactivatedAt: true,
          createdAt: true,
          platformMonthlyBudgetMicros: true,
        },
      });
      return userDto(updated);
    }),
  ).then(async (user) => {
    await recordSecurityEvent({
      type: "platform.account.role_changed",
      userId: actorUserId,
      metadata: { targetId: userId, role },
    });
    return user;
  });
}

export async function requestPlatformPasswordReset(
  deps: Pick<RouterDeps, "prisma" | "auth" | "env">,
  actorUserId: string,
  userId: string,
) {
  await requirePlatformRole(deps.prisma, actorUserId, "admin");
  const user = await runAsSystem("find account for password recovery", () =>
    deps.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        platformRole: true,
        platformMonitoringAcceptedAt: true,
        emailVerified: true,
        deactivatedAt: true,
      },
    }),
  );
  if (!user) throw new ClientError("NOT_FOUND", "Account not found");
  await deps.auth.api.requestPasswordReset({
    body: { email: user.email, redirectTo: new URL("/reset-password", deps.env.webOrigin).href },
  });
  await recordSecurityEvent({
    type: "platform.account.password_reset_requested",
    userId: actorUserId,
    metadata: { targetId: userId },
  });
}

export async function setPlatformMonthlyBudget(
  prisma: PlatformPrisma,
  actorUserId: string,
  userId: string,
  monthlyBudgetUsd: number,
): Promise<PlatformAdminUser> {
  await requirePlatformRole(prisma, actorUserId, "owner");
  const micros = BigInt(Math.round(monthlyBudgetUsd * Number(MICROS_PER_DOLLAR)));
  const user = await runAsSystem("set platform account monthly budget", async () => {
    return prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!target) throw new ClientError("NOT_FOUND", "Account not found");
      const currentMonthStart = monthStart();
      await tx.platformModelBudgetBucket.upsert({
        where: { userId_monthStart: { userId, monthStart: currentMonthStart } },
        create: { id: randomBytes(16).toString("hex"), userId, monthStart: currentMonthStart },
        update: {},
      });
      const [bucket] = await tx.$queryRaw<
        Array<{ id: string; reservedMicros: bigint; chargedMicros: bigint }>
      >`SELECT id, "reservedMicros", "chargedMicros" FROM "platform_model_budget_buckets"
        WHERE "userId" = ${userId} AND "monthStart" = ${currentMonthStart} FOR UPDATE`;
      if (!bucket) throw new Error("Company model budget is unavailable");
      const updated = await tx.user.update({
        where: { id: userId },
        data: { platformMonthlyBudgetMicros: micros },
        select: {
          id: true,
          email: true,
          name: true,
          emailVerified: true,
          platformMonitoringAcceptedAt: true,
          platformRole: true,
          deactivatedAt: true,
          createdAt: true,
          platformMonthlyBudgetMicros: true,
        },
      });
      await recordPlatformBudgetThresholdAlerts(tx, {
        userId,
        monthStart: currentMonthStart,
        budgetMicros: micros,
        chargedMicros: bucket.chargedMicros,
        reservedMicros: bucket.reservedMicros,
      });
      return userDto(updated);
    });
  });
  await recordSecurityEvent({
    type: "platform.account.budget_changed",
    userId: actorUserId,
    metadata: { targetId: userId, monthlyBudgetMicros: micros.toString() },
  });
  return user;
}

export function platformUsage(prisma: PlatformPrisma) {
  return platformAdminOverview(prisma);
}

export function platformUserAuditTarget(userId: string) {
  return userId;
}

export type PlatformTransaction = Prisma.TransactionClient;
