import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { resolvePlatformBotTenantScope, runAsTenantWithPlatformBots } from "@rakazo/db";

/** Rechecks current grant before every computer tool call, including before provisioning. */
export async function withPlatformBotComputerAccess<T>(
  prisma: PrismaClient,
  actor: { spaceId: string; userId: string },
  botId: string,
  computerId: string,
  work: () => Promise<T>,
): Promise<T> {
  const resolution = await resolvePlatformBotTenantScope(prisma, {
    ...actor,
    botId,
    botIds: [botId],
    requiredPermission: "use",
  });
  if (resolution.kind === "denied")
    throw new ClientError("FORBIDDEN", "Access to this bot's computer has been revoked");
  if (resolution.kind === "granted")
    return runAsTenantWithPlatformBots(resolution.scope, async () => {
      // A computer can be attached to several bots. The RLS policy only exposes it if
      // the actor has use access to every attached bot; do this lookup for each tool call
      // so a grant change is reflected even when the run already has a cached computer.
      const visible = await prisma.computer.findFirst({
        where: { id: computerId },
        select: { id: true },
      });
      if (!visible)
        throw new ClientError("FORBIDDEN", "Access to this shared computer is restricted");
      return work();
    });
  return work();
}
