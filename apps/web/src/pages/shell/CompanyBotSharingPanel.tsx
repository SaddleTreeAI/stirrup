import { Trans, useLingui } from "@lingui/react/macro";
import type { BotPermission } from "@rakazo/contracts";
import { OptionSelect, SectionHeading, toast } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useSave, useSpaceQueries } from "../../lib/query";
import { errorText } from "../../lib/user-error";

const ACCESS_VALUES = ["none", "use", "edit", "manage"] as const;
type AccessValue = (typeof ACCESS_VALUES)[number];

export function CompanyBotSharingPanel({ botId }: { botId: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const accessQuery = useQuery(queries.bots.access.list.queryOptions({ input: { botId } }));
  const change = useSave({
    save: (input: { botId: string; userId: string; permission: BotPermission | null }, rpc) =>
      input.permission
        ? rpc.bots.access.set({ ...input, permission: input.permission })
        : rpc.bots.access.revoke({ botId: input.botId, userId: input.userId }),
    stale: [queries.bots.access.list.key({ input: { botId } })],
    onFailed: (error) => toast.error(errorText(error, t`Could not change bot access`)),
  });
  const state = accessQuery.data;
  if (accessQuery.isPending || !state?.isCompanyBot) return null;

  return (
    <section className="space-y-3 border-t pt-4" aria-label={t`Bot access`}>
      <SectionHeading as="h3">
        <Trans>Company access</Trans>
      </SectionHeading>
      {accessQuery.error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {errorText(accessQuery.error, t`Could not load bot access`)}
        </p>
      ) : state.canManage ? (
        <ul className="space-y-2">
          {state.members.map((member) => {
            const value = (member.permission ?? "none") as AccessValue;
            return (
              <li key={member.userId} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body">{member.name}</p>
                  <p className="truncate text-body-sm text-muted-foreground">{member.email}</p>
                </div>
                <OptionSelect<AccessValue>
                  aria-label={t`Access for ${member.name}`}
                  value={value}
                  disabled={change.pending}
                  options={[
                    { value: "none", label: t`No access` },
                    { value: "use", label: t`Use` },
                    { value: "edit", label: t`Edit` },
                    { value: "manage", label: t`Manage` },
                  ]}
                  onValueChange={(next) => {
                    const permission = next === "none" ? null : (next as BotPermission);
                    change.run({ botId, userId: member.userId, permission });
                  }}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-body-sm text-muted-foreground">
          {state.permission === "manage" ? (
            <Trans>You can use, edit, and manage this bot.</Trans>
          ) : state.permission === "edit" ? (
            <Trans>You can use and edit this bot.</Trans>
          ) : state.permission === "use" ? (
            <Trans>You can use this bot.</Trans>
          ) : (
            <Trans>You do not have access to this bot.</Trans>
          )}
        </p>
      )}
    </section>
  );
}
