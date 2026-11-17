import { Trans, useLingui } from "@lingui/react/macro";
import type { PlatformAdminUser, PlatformRole } from "@rakazo/contracts";
import {
  Badge,
  Button,
  buttonVariants,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  SectionHeading,
  toast,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import { useSave, useSpaceQueries } from "../lib/query";
import { errorText } from "../lib/user-error";
import { CompanyProvidersPanel } from "./CompanyProvidersPanel";
import { PlatformOwnerBotInspection } from "./PlatformOwnerBotInspection";
import { WindowChrome } from "./WindowChrome";

export function AdminPlatformPage() {
  const me = useQuery(useSpaceQueries().me.queryOptions());
  if (me.isPending) return <PageLoading />;
  if (!me.data?.platformMode || !["owner", "admin"].includes(me.data.platformRole ?? "member"))
    return <Navigate to="/app" replace />;
  return <PlatformDashboard owner={me.data.platformRole === "owner"} />;
}

function PlatformDashboard({ owner }: { owner: boolean }) {
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const overview = useQuery(queries.platformAdmin.overview.queryOptions());
  const people = useQuery(queries.platformAdmin.users.list.queryOptions());
  const invites = useQuery(queries.platformAdmin.users.invites.queryOptions());
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = people.data?.find((person) => person.id === selectedId);
  const money = (value: number | null | undefined) =>
    value == null
      ? t`Unknown`
      : new Intl.NumberFormat(i18n.locale, { style: "currency", currency: "USD" }).format(value);
  const revoke = useSave({
    save: (inviteId: string, rpc) => rpc.platformAdmin.users.revokeInvite({ inviteId }),
    stale: [queries.platformAdmin.users.invites.key(), queries.platformAdmin.overview.key()],
    onFailed: (error) => toast.error(errorText(error, t`Could not revoke invitation`)),
  });
  const visible = (people.data ?? []).filter((person) =>
    `${person.name} ${person.email}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Link
          to="/app"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label={t`Back`}
        >
          <ChevronLeft />
        </Link>
        <h1 className="flex-1 font-medium">
          <Trans>Administration</Trans>
        </h1>
        <Button onClick={() => setAdding(true)}>
          <Plus />
          <Trans>Add person</Trans>
        </Button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-8 px-4 py-6">
          {overview.error || people.error ? (
            <p role="alert" className="text-destructive">
              {errorText(overview.error ?? people.error, t`Could not load administration`)}
            </p>
          ) : null}
          <dl className="grid grid-cols-2 gap-6 border-b pb-6 sm:grid-cols-4">
            <div>
              <dt className="text-label text-muted-foreground">
                <Trans>Active people</Trans>
              </dt>
              <dd className="mt-1 text-heading2 tabular-nums">
                {overview.data?.activeUsers ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-label text-muted-foreground">
                <Trans>Model cost this month</Trans>
              </dt>
              <dd className="mt-1 text-heading2 tabular-nums">
                {money(overview.data?.monthToDateCostUsd)}
              </dd>
            </div>
            <div>
              <dt className="text-label text-muted-foreground">
                <Trans>Model calls</Trans>
              </dt>
              <dd className="mt-1 text-heading2 tabular-nums">
                {overview.data?.monthToDateCalls.toLocaleString(i18n.locale) ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-label text-muted-foreground">
                <Trans>Pending invitations</Trans>
              </dt>
              <dd className="mt-1 text-heading2 tabular-nums">
                {overview.data?.pendingInvites ?? "—"}
              </dd>
            </div>
          </dl>
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SectionHeading as="h2">
                <Trans>People</Trans>
              </SectionHeading>
              <Input
                aria-label={t`Search people`}
                placeholder={t`Search people`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="max-w-xs"
              />
            </div>
            <div className="divide-y rounded-lg border" data-testid="platform-people">
              {visible.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  onClick={() => setSelectedId(person.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-start hover:bg-muted focus-visible:outline-ring"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {person.name || person.email}
                    </span>
                    <span className="block truncate text-label text-muted-foreground">
                      {person.email}
                    </span>
                  </span>
                  <Badge variant="secondary">
                    {person.pendingActivation
                      ? person.activationExpiresAt &&
                        Date.parse(person.activationExpiresAt) <= Date.now()
                        ? t`Activation expired`
                        : t`Awaiting activation`
                      : !person.active
                        ? t`Suspended`
                        : !person.emailVerified
                          ? t`Verify email`
                          : person.role !== "owner" && !person.monitoringAccepted
                            ? t`Awaiting consent`
                            : person.role === "owner"
                              ? t`Owner`
                              : person.role === "admin"
                                ? t`Admin`
                                : t`Member`}
                  </Badge>
                  <span className="hidden text-body-sm tabular-nums sm:block">
                    {money(person.monthToDateCostUsd)}
                  </span>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </button>
              ))}
              {!people.isPending && visible.length === 0 ? (
                <p className="p-4 text-muted-foreground">
                  <Trans>No matching people</Trans>
                </p>
              ) : null}
            </div>
          </section>
          {owner ? (
            <section>
              <Button
                variant="ghost"
                className="w-full justify-between"
                aria-expanded={providersOpen}
                onClick={() => setProvidersOpen((open) => !open)}
              >
                <Trans>Company model providers</Trans>
                <ChevronRight className={providersOpen ? "rotate-90" : undefined} />
              </Button>
              {providersOpen ? <CompanyProvidersPanel people={people.data ?? []} /> : null}
            </section>
          ) : null}
          {invites.data?.length ? (
            <section className="space-y-3">
              <SectionHeading as="h2">
                <Trans>Invitations</Trans>
              </SectionHeading>
              <div className="divide-y">
                {invites.data.map((invite) => (
                  <div key={invite.id} className="flex items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate">{invite.email}</p>
                      <p className="text-label text-muted-foreground">
                        <Trans>Expires</Trans>{" "}
                        {new Date(invite.expiresAt).toLocaleDateString(i18n.locale)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      disabled={revoke.pending}
                      onClick={() => revoke.run(invite.id)}
                    >
                      <Trans>Revoke</Trans>
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          <p className="text-label text-muted-foreground">
            <Trans>
              Usage costs are provider-reported or estimated; they may differ from invoices.
            </Trans>
          </p>
        </div>
      </main>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Add person</Trans>
            </DialogTitle>
          </DialogHeader>
          <InvitePerson owner={owner} />
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selected?.name || selected?.email}</DialogTitle>
          </DialogHeader>
          {selected ? <PersonDetails key={selected.id} person={selected} owner={owner} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InvitePerson({ owner }: { owner: boolean }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [kind, setKind] = useState<"invite" | "provision">("invite");
  const [url, setUrl] = useState<string | null>(null);
  const create = useSave({
    save: (input: { name: string; email: string; role: "admin" | "member" }, rpc) =>
      kind === "provision"
        ? rpc.platformAdmin.users.createProvision(input)
        : rpc.platformAdmin.users.createInvite(input),
    stale: [
      queries.platformAdmin.users.list.key(),
      queries.platformAdmin.users.invites.key(),
      queries.platformAdmin.overview.key(),
    ],
    onSaved: (result) => setUrl(result.url),
    onFailed: (error) => toast.error(errorText(error, t`Could not create invitation`)),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    create.run({ name, email, role });
  }
  if (url)
    return (
      <div className="space-y-3">
        <Field>
          <FieldLabel htmlFor="platform-invite-url">
            {kind === "provision" ? <Trans>Activation link</Trans> : <Trans>Invitation link</Trans>}
          </FieldLabel>
          <Input
            id="platform-invite-url"
            readOnly
            value={url}
            onFocus={(event) => event.target.select()}
          />
        </Field>
        <p className="text-label text-muted-foreground">
          {kind === "provision" ? (
            <Trans>
              Share this private link so the person can set a password and activate the account.
            </Trans>
          ) : (
            <Trans>Share this private link with the invited person.</Trans>
          )}
        </p>
      </div>
    );
  return (
    <form onSubmit={submit} className="space-y-4">
      {owner ? (
        <div className="flex gap-2">
          <Button
            type="button"
            variant={kind === "provision" ? "secondary" : "ghost"}
            aria-pressed={kind === "provision"}
            onClick={() => setKind("provision")}
          >
            <Trans>Create account</Trans>
          </Button>
          <Button
            type="button"
            variant={kind === "invite" ? "secondary" : "ghost"}
            aria-pressed={kind === "invite"}
            onClick={() => setKind("invite")}
          >
            <Trans>Invite person</Trans>
          </Button>
        </div>
      ) : null}
      <Field>
        <FieldLabel htmlFor="platform-invite-name">
          <Trans>Name</Trans>
        </FieldLabel>
        <Input
          id="platform-invite-name"
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="platform-invite-email">
          <Trans>Email</Trans>
        </FieldLabel>
        <Input
          id="platform-invite-email"
          type="email"
          required
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      {owner ? (
        <fieldset className="flex gap-2" aria-label={t`Role`}>
          <Button
            type="button"
            variant={role === "member" ? "secondary" : "ghost"}
            aria-pressed={role === "member"}
            onClick={() => setRole("member")}
          >
            <Trans>Member</Trans>
          </Button>
          <Button
            type="button"
            variant={role === "admin" ? "secondary" : "ghost"}
            aria-pressed={role === "admin"}
            onClick={() => setRole("admin")}
          >
            <Trans>Admin</Trans>
          </Button>
        </fieldset>
      ) : null}
      <Button type="submit" disabled={create.pending}>
        {kind === "provision" ? (
          <Trans>Create account link</Trans>
        ) : (
          <Trans>Create invitation</Trans>
        )}
      </Button>
    </form>
  );
}

function PersonDetails({ person, owner }: { person: PlatformAdminUser; owner: boolean }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [editingBudget, setEditingBudget] = useState(false);
  const [budget, setBudget] = useState(String(person.monthlyBudgetUsd));
  const [activationUrl, setActivationUrl] = useState<string | null>(null);
  const budgetChange = useSave({
    save: (monthlyBudgetUsd: number, rpc) =>
      rpc.platformAdmin.users.setBudget({ userId: person.id, monthlyBudgetUsd }),
    stale: [queries.platformAdmin.users.list.key()],
    onSaved: () => setEditingBudget(false),
    onFailed: (error) => toast.error(errorText(error, t`Could not update budget`)),
  });
  type Action = { kind: "reset" | "suspend" | "reactivate" } | { kind: "role"; role: PlatformRole };
  const action = useSave({
    save: async (input: Action, rpc) => {
      const userId = person.id;
      if (input.kind === "role")
        await rpc.platformAdmin.users.setRole({ userId, role: input.role });
      else if (input.kind === "reset") await rpc.platformAdmin.users.sendPasswordReset({ userId });
      else if (input.kind === "suspend") await rpc.platformAdmin.users.deactivate({ userId });
      else await rpc.platformAdmin.users.reactivate({ userId });
    },
    stale: [queries.platformAdmin.users.list.key(), queries.platformAdmin.overview.key()],
    onSaved: (_result, input) => {
      if (input.kind === "reset") toast.success(t`Password reset requested`);
    },
    onFailed: (error) => toast.error(errorText(error, t`Could not update person`)),
  });
  const pendingRole = useSave({
    save: (role: "admin" | "member", rpc) =>
      rpc.platformAdmin.users.setProvisionRole({ inviteId: person.activationInviteId!, role }),
    stale: [queries.platformAdmin.users.list.key()],
    onFailed: (error) => toast.error(errorText(error, t`Could not update pending account`)),
  });
  const resend = useSave({
    save: (_value: undefined, rpc) =>
      rpc.platformAdmin.users.resendProvision({ inviteId: person.activationInviteId! }),
    stale: [queries.platformAdmin.users.list.key()],
    onSaved: (result) => setActivationUrl(result.url),
    onFailed: (error) => toast.error(errorText(error, t`Could not create an activation link`)),
  });
  const revokePending = useSave({
    save: (_value: undefined, rpc) =>
      rpc.platformAdmin.users.revokeInvite({ inviteId: person.activationInviteId! }),
    stale: [queries.platformAdmin.users.list.key(), queries.platformAdmin.overview.key()],
    onFailed: (error) => toast.error(errorText(error, t`Could not revoke pending account`)),
  });
  if (person.pendingActivation) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground">{person.email}</p>
        <p>
          {person.activationExpiresAt && Date.parse(person.activationExpiresAt) <= Date.now() ? (
            <Trans>This activation link expired. Create a new link to restore access.</Trans>
          ) : (
            <Trans>
              This account becomes active after email verification and workspace consent.
            </Trans>
          )}
        </p>
        {owner ? (
          <fieldset className="flex gap-2" aria-label={t`Role`}>
            <Button
              variant={person.role === "member" ? "secondary" : "ghost"}
              disabled={pendingRole.pending}
              onClick={() => pendingRole.run("member")}
            >
              <Trans>Member</Trans>
            </Button>
            <Button
              variant={person.role === "admin" ? "secondary" : "ghost"}
              disabled={pendingRole.pending}
              onClick={() => pendingRole.run("admin")}
            >
              <Trans>Admin</Trans>
            </Button>
          </fieldset>
        ) : null}
        {activationUrl ? (
          <Field>
            <FieldLabel htmlFor="platform-activation-url">
              <Trans>Activation link</Trans>
            </FieldLabel>
            <Input
              id="platform-activation-url"
              readOnly
              value={activationUrl}
              onFocus={(event) => event.target.select()}
            />
          </Field>
        ) : null}
        {owner ? (
          <div className="flex flex-wrap gap-2">
            <Button disabled={resend.pending} onClick={() => resend.run(undefined)}>
              <Trans>Resend activation</Trans>
            </Button>
            <Button
              variant="ghost"
              disabled={revokePending.pending}
              onClick={() => revokePending.run(undefined)}
            >
              <Trans>Revoke account link</Trans>
            </Button>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <p className="text-muted-foreground">{person.email}</p>
      {!person.emailVerified || (person.role !== "owner" && !person.monitoringAccepted) ? (
        <p className="rounded-md border p-3 text-body-sm text-muted-foreground">
          {!person.emailVerified ? (
            <Trans>This account has not verified its email address.</Trans>
          ) : (
            <Trans>
              This account is visible to platform owners but cannot join the company workspace or
              use company providers until its owner monitoring consent is accepted.
            </Trans>
          )}
        </p>
      ) : null}
      <dl className="grid grid-cols-2 gap-3 text-body-sm">
        <dt>
          <Trans>Company model budget</Trans>
        </dt>
        <dd className="text-end tabular-nums">${person.monthlyBudgetUsd.toFixed(2)}</dd>
        <dt>
          <Trans>Company provider charged</Trans>
        </dt>
        <dd className="text-end tabular-nums">
          ${(person.companyBudgetChargedUsd ?? 0).toFixed(2)}
        </dd>
        <dt>
          <Trans>Company provider reserved</Trans>
        </dt>
        <dd className="text-end tabular-nums">
          ${(person.companyBudgetReservedUsd ?? 0).toFixed(2)}
        </dd>
        <dt>
          <Trans>Model calls this month</Trans>
        </dt>
        <dd className="text-end tabular-nums">{person.monthToDateCalls}</dd>
      </dl>
      {person.companyBudgetAlerts?.length ? (
        <div className="space-y-1 rounded-md border p-3 text-body-sm">
          <p className="font-medium">
            <Trans>Budget alerts this month</Trans>
          </p>
          {person.companyBudgetAlerts.map((alert) => (
            <p key={alert.thresholdPercent} className="text-muted-foreground">
              {alert.sentAt ? (
                <Trans>{alert.thresholdPercent}% email sent</Trans>
              ) : (
                <Trans>{alert.thresholdPercent}% email queued</Trans>
              )}
            </p>
          ))}
        </div>
      ) : null}
      {editingBudget ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            budgetChange.run(Number(budget));
          }}
        >
          <Field>
            <FieldLabel htmlFor="person-monthly-budget">
              <Trans>Monthly limit (USD)</Trans>
            </FieldLabel>
            <Input
              id="person-monthly-budget"
              type="number"
              min="0"
              max="100000"
              step="0.01"
              required
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
            />
          </Field>
          <Button type="submit" disabled={budgetChange.pending}>
            <Trans>Save</Trans>
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={budgetChange.pending}
            onClick={() => setEditingBudget(false)}
          >
            <Trans>Cancel</Trans>
          </Button>
        </form>
      ) : (
        <Button variant="ghost" onClick={() => setEditingBudget(true)}>
          <Trans>Edit budget</Trans>
        </Button>
      )}
      {owner && person.role !== "owner" ? (
        <fieldset className="flex gap-2" aria-label={t`Role`}>
          <Button
            variant={person.role === "member" ? "secondary" : "ghost"}
            disabled={action.pending}
            onClick={() => action.run({ kind: "role", role: "member" })}
          >
            <Trans>Member</Trans>
          </Button>
          <Button
            variant={person.role === "admin" ? "secondary" : "ghost"}
            disabled={action.pending}
            onClick={() => action.run({ kind: "role", role: "admin" })}
          >
            <Trans>Admin</Trans>
          </Button>
        </fieldset>
      ) : null}
      <Button
        variant="outline"
        disabled={action.pending}
        onClick={() => action.run({ kind: "reset" })}
      >
        <Trans>Send password reset</Trans>
      </Button>
      {person.role !== "owner" ? (
        <div className="border-t pt-4">
          <Button
            variant="ghost"
            disabled={action.pending}
            onClick={() => action.run({ kind: person.active ? "suspend" : "reactivate" })}
          >
            {person.active ? <Trans>Suspend account</Trans> : <Trans>Reactivate account</Trans>}
          </Button>
        </div>
      ) : null}
      {owner ? <PlatformOwnerBotInspection userId={person.id} /> : null}
    </div>
  );
}
