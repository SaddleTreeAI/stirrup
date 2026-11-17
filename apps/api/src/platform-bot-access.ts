import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";

export type PlatformBotPermission = "use" | "edit" | "manage";
export type PlatformBotRequirement = PlatformBotPermission | "deny";

export type PlatformBotScope = {
  spaceId: string;
  userId: string;
  companySpaceId: string;
  useBotIds: string[];
  editBotIds: string[];
  manageBotIds: string[];
  requiredPermission: PlatformBotRequirement;
};

const PROCEDURE_PERMISSION: Readonly<Record<string, PlatformBotPermission | "deny">> = {
  "spaces.list": "use",
  "notifications.subscribe": "use",
  "search.query": "use",
  "export.bot": "use",
  "bots.list": "use",
  "bots.listArchived": "use",
  "bots.get": "use",
  "bots.create": "manage",
  "bots.importPreview": "deny",
  "bots.importCreate": "deny",
  "bots.importSetupState": "deny",
  "bots.templates": "deny",
  "bots.createFromTemplate": "deny",
  "bots.duplicate": "manage",
  "bots.reorder": "edit",
  "bots.update": "edit",
  "bots.restoreInstructions": "edit",
  "bots.setComputer": "edit",
  "bots.archive": "manage",
  "bots.restore": "manage",
  "bots.remove": "manage",
  "bots.removePreview": "manage",
  "bots.emailAddress": "use",
  "bots.emailAddresses": "use",
  "bots.claimEmailAddress": "manage",
  "bots.rotateWebhookSecret": "manage",
  "bots.revealWebhookSecret": "manage",
  "bots.access.list": "use",
  "bots.access.set": "manage",
  "bots.access.revoke": "manage",
  "groups.list": "use",
  "groups.listArchived": "use",
  "groups.get": "use",
  "groups.create": "edit",
  "groups.duplicate": "edit",
  "groups.update": "edit",
  "groups.archive": "manage",
  "groups.restore": "manage",
  "groups.remove": "manage",
  "botSections.list": "use",
  "botSections.create": "edit",
  "botSections.update": "edit",
  "botSections.remove": "edit",
  "threads.head": "use",
  "threads.get": "use",
  "threads.messages": "use",
  "threads.subscribe": "use",
  "threads.send": "use",
  "threads.sendWithRoutines": "use",
  "threads.react": "use",
  "threads.stop": "use",
  "threads.stopHelper": "use",
  "threads.followUp": "use",
  "threads.endCall": "use",
  "threads.answerCall": "use",
  "threads.declineCall": "use",
  "threads.clear": "manage",
  "threads.answer": "use",
  "threads.markRead": "use",
  "threads.markUnread": "use",
  "threads.snooze": "use",
  "computer.status": "use",
  "computer.boot": "use",
  "computer.stop": "manage",
  "computer.recover": "manage",
  "computer.reset": "manage",
  "computer.update": "manage",
  "computer.updates": "use",
  "computer.dismissUpdate": "manage",
  "computer.dismissDiskWarning": "manage",
  "computer.takeover": "manage",
  "computer.release": "manage",
  "computer.input": "use",
  "computer.files": "use",
  "computer.readFile": "use",
  "computer.downloadFile": "use",
  "computer.uploadFile": "edit",
  "computer.terminalUrl": "manage",
  "computer.commands": "use",
  "computer.screenUrl": "use",
  "computer.preview": "use",
  "computer.heartbeat": "use",
  "memory.list": "use",
  "memory.budget": "use",
  "memory.update": "edit",
  "memory.remove": "edit",
  "memory.exportMarkdown": "use",
  "memory.providerConfig": "use",
  "memory.providers": "use",
  "memory.connectProvider": "deny",
  "memory.updateProvider": "deny",
  "memory.setDefaultScope": "deny",
  "memory.disconnectProvider": "deny",
  "routines.listForMentions": "use",
  "routines.list": "use",
  "routines.history": "use",
  "routines.create": "edit",
  "routines.update": "edit",
  "routines.remove": "edit",
  "routines.testRun": "use",
  "scratchpad.list": "use",
  "scratchpad.create": "edit",
  "scratchpad.update": "edit",
  "scratchpad.remove": "edit",
  "skills.list": "use",
  "skills.get": "use",
  "skills.start": "edit",
  "skills.appendEvent": "edit",
  "skills.snapshot": "use",
  "skills.stop": "edit",
  "skills.updateDraft": "edit",
  "skills.save": "edit",
  "skills.testRun": "use",
  "skills.remove": "edit",
  "mcp.assignments.all": "use",
  "mcp.assignments.list": "use",
  "mcp.assignments.approve": "edit",
  "mcp.assignments.dismiss": "edit",
  "mcp.assignments.replace": "edit",
  "pages.list": "use",
  "pages.get": "use",
  "pages.rename": "edit",
  "pages.setVisibility": "edit",
  "pages.pin": "edit",
  "pages.remove": "edit",
  "botSecrets.list": "use",
  "botSecrets.put": "edit",
  "botSecrets.remove": "edit",
};

const BOT_SCOPED_NAMESPACES = new Set([
  "bots",
  "groups",
  "botSections",
  "threads",
  "computer",
  "memory",
  "routines",
  "scratchpad",
  "skills",
  "pages",
  "botSecrets",
]);

/** Unknown bot-surface procedures fail closed when a deployment enables a Company Space. */
export function requiredPlatformBotPermission(path: readonly string[]): PlatformBotRequirement {
  const procedure = path.join(".");
  const required = PROCEDURE_PERMISSION[procedure];
  if (required) return required;
  if (BOT_SCOPED_NAMESPACES.has(path[0] ?? "")) return "deny";
  if (path[0] === "mcp" && path[1] === "assignments") return "deny";
  return "use";
}

/**
 * Resolves only the signed-in member's grants for bots in the configured Company Space.
 * The narrow system read is necessary because grant rows are invisible to ordinary tenants.
 */
export async function resolvePlatformBotScope(
  prisma: PrismaClient,
  actor: Actor,
  path: readonly string[],
): Promise<PlatformBotScope | null> {
  const companySpaceId = await runAsSystem("resolve authenticated company bot access", async () => {
    const settings = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { companySpaceId: true },
    });
    return settings?.companySpaceId === actor.spaceId ? settings.companySpaceId : null;
  });
  if (!companySpaceId) return null;
  const resolved = await runAsSystem("resolve authenticated company bot access", async () => {
    const [user, grants] = await Promise.all([
      prisma.user.findUnique({ where: { id: actor.userId }, select: { platformRole: true } }),
      prisma.platformBotGrant.findMany({
        where: { userId: actor.userId },
        select: { botId: true, permission: true, bot: { select: { spaceId: true, userId: true } } },
      }),
    ]);
    const elevated = user?.platformRole === "owner" || user?.platformRole === "admin";
    const botIds = elevated
      ? await prisma.bot.findMany({ where: { spaceId: companySpaceId }, select: { id: true } })
      : [];
    return { companySpaceId, grants, elevated, botIds };
  });
  const { grants, elevated, botIds } = resolved;
  const useBotIds: string[] = [];
  const editBotIds: string[] = [];
  const manageBotIds: string[] = [];
  if (elevated) {
    for (const bot of botIds) {
      useBotIds.push(bot.id);
      editBotIds.push(bot.id);
      manageBotIds.push(bot.id);
    }
  }
  for (const grant of grants) {
    if (grant.bot.spaceId !== companySpaceId) continue;
    const permission = elevated || grant.bot.userId === actor.userId ? "manage" : grant.permission;
    if (permission === "use" || permission === "edit" || permission === "manage")
      useBotIds.push(grant.botId);
    if (permission === "edit" || permission === "manage") editBotIds.push(grant.botId);
    if (permission === "manage") manageBotIds.push(grant.botId);
  }
  if (!elevated) {
    const owned = await runAsSystem("resolve authenticated company bot access", () =>
      prisma.bot.findMany({
        where: { spaceId: companySpaceId, userId: actor.userId },
        select: { id: true },
      }),
    );
    for (const bot of owned) {
      useBotIds.push(bot.id);
      editBotIds.push(bot.id);
      manageBotIds.push(bot.id);
    }
  }
  return {
    spaceId: actor.spaceId,
    userId: actor.userId,
    companySpaceId,
    useBotIds,
    editBotIds,
    manageBotIds,
    requiredPermission: requiredPlatformBotPermission(path),
  };
}
