import { ClientError } from "@rakazo/core";
import { recordSecurityEvent, runAsSystem } from "@rakazo/db";
import {
  createPlatformInvite,
  listPlatformInvites,
  listPlatformUsers,
  platformAdminOverview,
  platformUsage,
  previewPlatformInvite,
  requestPlatformPasswordReset,
  requireCanDeactivatePlatformAccount,
  requirePlatformRole,
  resendPlatformProvision,
  revokePlatformInvite,
  setPlatformMonthlyBudget,
  setPlatformProvisionRole,
  setPlatformRole,
} from "../platform-admin.js";
import { inspectPlatformBot, listPlatformUserBots } from "../platform-admin-bots.js";
import { getPlatformCompanySpace, setupPlatformCompanySpace } from "../platform-company-space.js";
import {
  deletePlatformModelConnection,
  listPlatformModelConnections,
  platformProviderCatalog,
  platformProviderOptions,
  savePlatformModelConnection,
  setPlatformModelConnectionEnabled,
  setPlatformModelGrant,
} from "../platform-models.js";
import type { RouterContext } from "./context.js";

export function platformAdminRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    platformInvite: {
      preview: ctx.os.platformInvite.preview.handler(({ input }) =>
        previewPlatformInvite(deps.prisma, input.token),
      ),
    },
    platformAdmin: {
      companySpace: {
        get: authed.platformAdmin.companySpace.get.handler(async ({ context }) => {
          await requirePlatformRole(deps.prisma, context.actor.userId);
          return getPlatformCompanySpace(deps.prisma);
        }),
        setup: authed.platformAdmin.companySpace.setup.handler(async ({ context, input }) => {
          await requirePlatformRole(deps.prisma, context.actor.userId, "owner");
          return setupPlatformCompanySpace(deps.prisma, context.actor.userId, input.spaceId);
        }),
      },
      bots: {
        listForUser: authed.platformAdmin.bots.listForUser.handler(({ context, input }) =>
          listPlatformUserBots(deps.prisma, context.actor.userId, input.userId),
        ),
        inspect: authed.platformAdmin.bots.inspect.handler(({ context, input }) =>
          inspectPlatformBot(deps.prisma, context.actor.userId, input.botId, input),
        ),
      },
      overview: authed.platformAdmin.overview.handler(async ({ context }) => {
        await requirePlatformRole(deps.prisma, context.actor.userId);
        return platformAdminOverview(deps.prisma);
      }),
      usage: authed.platformAdmin.usage.handler(async ({ context }) => {
        await requirePlatformRole(deps.prisma, context.actor.userId);
        return platformUsage(deps.prisma);
      }),
      providers: {
        available: authed.platformAdmin.providers.available.handler(async ({ context }) => {
          await requirePlatformRole(deps.prisma, context.actor.userId, "owner");
          return platformProviderOptions();
        }),
        list: authed.platformAdmin.providers.list.handler(async ({ context }) => {
          await requirePlatformRole(deps.prisma, context.actor.userId, "owner");
          return listPlatformModelConnections(deps.prisma);
        }),
        catalog: authed.platformAdmin.providers.catalog.handler(async ({ context, input }) => {
          await requirePlatformRole(deps.prisma, context.actor.userId, "owner");
          return platformProviderCatalog(deps, input.provider);
        }),
        saveConnection: authed.platformAdmin.providers.saveConnection.handler(
          async ({ context, input }) => {
            await requirePlatformRole(deps.prisma, context.actor.userId, "owner");
            return savePlatformModelConnection(deps, context.actor.userId, input);
          },
        ),
        setConnectionEnabled: authed.platformAdmin.providers.setConnectionEnabled.handler(
          async ({ context, input }) => {
            await requirePlatformRole(deps.prisma, context.actor.userId, "owner");
            return setPlatformModelConnectionEnabled(
              deps.prisma,
              context.actor.userId,
              input.provider,
              input.enabled,
            );
          },
        ),
        deleteConnection: authed.platformAdmin.providers.deleteConnection.handler(
          async ({ context, input }) => {
            await requirePlatformRole(deps.prisma, context.actor.userId, "owner");
            await deletePlatformModelConnection(deps, context.actor.userId, input.provider);
            return { ok: true as const };
          },
        ),
        setGrant: authed.platformAdmin.providers.setGrant.handler(async ({ context, input }) => {
          await requirePlatformRole(deps.prisma, context.actor.userId, "owner");
          return setPlatformModelGrant(deps.prisma, context.actor.userId, input);
        }),
      },
      users: {
        list: authed.platformAdmin.users.list.handler(async ({ context }) => {
          return listPlatformUsers(deps.prisma, context.actor.userId);
        }),
        createInvite: authed.platformAdmin.users.createInvite.handler(async ({ context, input }) =>
          createPlatformInvite(deps, context.actor.userId, input),
        ),
        createProvision: authed.platformAdmin.users.createProvision.handler(
          async ({ context, input }) =>
            createPlatformInvite(deps, context.actor.userId, input, "provision"),
        ),
        setProvisionRole: authed.platformAdmin.users.setProvisionRole.handler(
          async ({ context, input }) => {
            await setPlatformProvisionRole(
              deps.prisma,
              context.actor.userId,
              input.inviteId,
              input.role,
            );
            return { ok: true as const };
          },
        ),
        resendProvision: authed.platformAdmin.users.resendProvision.handler(
          async ({ context, input }) =>
            resendPlatformProvision(deps, context.actor.userId, input.inviteId),
        ),
        deactivate: authed.platformAdmin.users.deactivate.handler(async ({ context, input }) => {
          const actorRole = await requirePlatformRole(deps.prisma, context.actor.userId);
          if (!deps.setPlatformAccountActive)
            throw new ClientError("SERVICE_UNAVAILABLE", "Account management is unavailable");
          const target = await runAsSystem("authorize platform account deactivation", () =>
            deps.prisma.user.findUnique({
              where: { id: input.userId },
              select: {
                platformRole: true,
                platformMonitoringAcceptedAt: true,
                emailVerified: true,
                deactivatedAt: true,
              },
            }),
          );
          if (!target) throw new ClientError("NOT_FOUND", "Account not found");
          requireCanDeactivatePlatformAccount({
            actorUserId: context.actor.userId,
            actorRole,
            targetUserId: input.userId,
            targetRole: target.platformRole as "owner" | "admin" | "member",
          });
          const result = await deps.setPlatformAccountActive(input.userId, false);
          if (result === "directory")
            throw new ClientError("CONFLICT", "This account is managed by the directory");
          return { ok: true as const };
        }),
        reactivate: authed.platformAdmin.users.reactivate.handler(async ({ context, input }) => {
          const actorRole = await requirePlatformRole(deps.prisma, context.actor.userId);
          if (!deps.setPlatformAccountActive)
            throw new ClientError("SERVICE_UNAVAILABLE", "Account management is unavailable");
          const target = await runAsSystem("authorize platform account reactivation", () =>
            deps.prisma.user.findUnique({
              where: { id: input.userId },
              select: {
                platformRole: true,
                platformMonitoringAcceptedAt: true,
                emailVerified: true,
              },
            }),
          );
          if (!target) throw new ClientError("NOT_FOUND", "Account not found");
          if (actorRole !== "owner" && target.platformRole !== "member")
            throw new ClientError("FORBIDDEN", "Only an owner can reactivate administrators");
          const result = await deps.setPlatformAccountActive(input.userId, true);
          if (result === "directory")
            throw new ClientError("CONFLICT", "This account is managed by the directory");
          return { ok: true as const };
        }),
        setRole: authed.platformAdmin.users.setRole.handler(({ context, input }) =>
          setPlatformRole(deps.prisma, context.actor.userId, input.userId, input.role),
        ),
        setBudget: authed.platformAdmin.users.setBudget.handler(({ context, input }) =>
          setPlatformMonthlyBudget(
            deps.prisma,
            context.actor.userId,
            input.userId,
            input.monthlyBudgetUsd,
          ),
        ),
        sendPasswordReset: authed.platformAdmin.users.sendPasswordReset.handler(
          async ({ context, input }) => {
            if (!deps.email)
              throw new ClientError("BAD_REQUEST", "Password recovery email is not configured");
            const actorRole = await requirePlatformRole(deps.prisma, context.actor.userId);
            const target = await runAsSystem("authorize platform password recovery", () =>
              deps.prisma.user.findUnique({
                where: { id: input.userId },
                select: { platformRole: true },
              }),
            );
            if (!target) throw new ClientError("NOT_FOUND", "Account not found");
            if (actorRole !== "owner" && target.platformRole !== "member")
              throw new ClientError(
                "FORBIDDEN",
                "Only an owner can recover an administrator account",
              );
            await requestPlatformPasswordReset(deps, context.actor.userId, input.userId);
            return { ok: true as const };
          },
        ),
        invites: authed.platformAdmin.users.invites.handler(async ({ context }) => {
          await requirePlatformRole(deps.prisma, context.actor.userId);
          return listPlatformInvites(deps.prisma);
        }),
        revokeInvite: authed.platformAdmin.users.revokeInvite.handler(
          async ({ context, input }) => {
            await requirePlatformRole(deps.prisma, context.actor.userId);
            await revokePlatformInvite(deps.prisma, input.inviteId);
            await recordSecurityEvent({
              type: "platform.account.invite_revoked",
              userId: context.actor.userId,
              metadata: { targetId: input.inviteId, action: "revoked" },
            });
            return { ok: true as const };
          },
        ),
      },
    },
  };
}
