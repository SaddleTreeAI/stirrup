import { Trans, useLingui } from "@lingui/react/macro";
import type {
  PlatformAdminUser,
  PlatformModelConnection,
  PlatformProviderCatalog,
} from "@rakazo/contracts";
import { Badge, Button, Field, FieldLabel, Input, OptionSelect, toast } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, RefreshCw } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useSave, useSpaceQueries } from "../lib/query";
import { errorText } from "../lib/user-error";

export function CompanyProvidersPanel({ people }: { people: PlatformAdminUser[] }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const available = useQuery(queries.platformAdmin.providers.available.queryOptions());
  const connections = useQuery(queries.platformAdmin.providers.list.queryOptions());
  const [provider, setProvider] = useState("");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [editingConnection, setEditingConnection] = useState(false);
  const activeProvider = provider || available.data?.[0]?.provider || "";
  const connection = connections.data?.find((item) => item.provider === activeProvider);
  const selectedProvider = activeProvider || provider;
  const catalog = useQuery({
    ...queries.platformAdmin.providers.catalog.queryOptions({
      input: { provider: activeProvider },
    }),
    enabled: Boolean(activeProvider),
  });
  const options = (available.data ?? []).map((item) => ({
    value: item.provider,
    label: item.providerName,
  }));
  const saveConnection = useSave({
    save: (
      input: { provider: string; label: string; apiKey?: string },
      rpc,
    ): Promise<PlatformModelConnection> => rpc.platformAdmin.providers.saveConnection(input),
    stale: [queries.platformAdmin.providers.list.key()],
    onSaved: () => {
      setApiKey("");
      setEditingConnection(false);
    },
    onFailed: (error) => toast.error(errorText(error, t`Could not save provider connection`)),
  });
  const setEnabled = useSave({
    save: (input: { provider: string; enabled: boolean }, rpc): Promise<PlatformModelConnection> =>
      rpc.platformAdmin.providers.setConnectionEnabled(input),
    stale: [queries.platformAdmin.providers.list.key()],
    onFailed: (error) => toast.error(errorText(error, t`Could not change provider availability`)),
  });
  const remove = useSave({
    save: (providerId: string, rpc) =>
      rpc.platformAdmin.providers.deleteConnection({ provider: providerId }),
    stale: [queries.platformAdmin.providers.list.key()],
    onFailed: (error) => toast.error(errorText(error, t`Could not remove provider connection`)),
  });

  useEffect(() => {
    if (!provider && available.data?.[0]) setProvider(available.data[0].provider);
  }, [available.data, provider]);
  useEffect(() => {
    setEditingConnection(!connection);
  }, [selectedProvider, connection?.id]);
  useEffect(() => {
    setLabel(
      connection?.label ??
        available.data?.find((item) => item.provider === selectedProvider)?.providerName ??
        "",
    );
  }, [available.data, connection?.label, selectedProvider]);

  function save(event: FormEvent) {
    event.preventDefault();
    if (!selectedProvider) return;
    saveConnection.run({
      provider: selectedProvider,
      label:
        label.trim() ||
        available.data?.find((item) => item.provider === selectedProvider)?.providerName ||
        selectedProvider,
      ...(apiKey.trim() ? { apiKey } : {}),
    });
  }

  return (
    <section className="space-y-4 border-t pt-6" data-testid="company-providers">
      <div className="space-y-1">
        <h2 className="font-medium">
          <Trans>Company model providers</Trans>
        </h2>
        <p className="text-label text-muted-foreground">
          <Trans>
            Company keys are shared only through explicit per-person model grants. Personal keys
            remain private.
          </Trans>
        </p>
      </div>
      {available.error || connections.error ? (
        <p role="alert" className="text-destructive">
          {errorText(available.error ?? connections.error, t`Could not load company providers`)}
        </p>
      ) : null}
      {options.length ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(16rem,0.65fr)_minmax(0,1.35fr)]">
          <div className="space-y-4 rounded-lg border p-4">
            <Field>
              <FieldLabel htmlFor="company-provider">
                <Trans>Provider</Trans>
              </FieldLabel>
              <OptionSelect
                id="company-provider"
                value={selectedProvider}
                options={options}
                onValueChange={(next) => {
                  setProvider(next);
                  setLabel(
                    available.data?.find((item) => item.provider === next)?.providerName ?? next,
                  );
                  setApiKey("");
                }}
              />
            </Field>
            <div className="flex items-center gap-2">
              <KeyRound className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">
                {connection?.label ?? t`No company key saved`}
              </span>
              {connection ? (
                <>
                  <Badge variant={connection.enabled ? "default" : "secondary"}>
                    {connection.enabled ? t`Available` : t`Paused`}
                  </Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingConnection((editing) => !editing)}
                  >
                    {editingConnection ? t`Cancel` : t`Edit`}
                  </Button>
                </>
              ) : null}
            </div>
            {connection && !editingConnection ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={setEnabled.pending}
                  onClick={() =>
                    setEnabled.run({ provider: selectedProvider, enabled: !connection.enabled })
                  }
                >
                  {connection.enabled ? t`Pause` : t`Enable`}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={remove.pending}
                  onClick={() => remove.run(selectedProvider)}
                >
                  <Trans>Remove</Trans>
                </Button>
              </div>
            ) : (
              <form onSubmit={save} className="space-y-3">
                <Field>
                  <FieldLabel htmlFor="company-provider-label">
                    <Trans>Display name</Trans>
                  </FieldLabel>
                  <Input
                    id="company-provider-label"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    maxLength={120}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="company-provider-key">
                    <Trans>Provider API key</Trans>
                  </FieldLabel>
                  <Input
                    id="company-provider-key"
                    type="password"
                    autoComplete="new-password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={
                      connection?.secretConfigured
                        ? t`Saved key. Enter a new key to replace it.`
                        : t`Enter a provider API key`
                    }
                  />
                </Field>
                <p className="text-label text-muted-foreground">
                  <Trans>
                    Subscription sign-ins are not accepted. The key is encrypted and never shown
                    again.
                  </Trans>
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    disabled={saveConnection.pending || (!apiKey.trim() && !connection)}
                  >
                    <Trans>{connection ? "Save connection" : "Save provider key"}</Trans>
                  </Button>
                  {connection ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setEditingConnection(false)}
                    >
                      <Trans>Cancel</Trans>
                    </Button>
                  ) : null}
                </div>
              </form>
            )}
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="font-medium">
                  <Trans>Access grants</Trans>
                </h3>
                <p className="text-label text-muted-foreground">
                  <Trans>
                    Grant access per person and model. Budgeted company calls count against their
                    monthly user budget.
                  </Trans>
                </p>
              </div>
              {catalog.isFetching ? (
                <RefreshCw
                  className="size-4 animate-spin text-muted-foreground"
                  aria-label={t`Loading provider catalog`}
                />
              ) : null}
            </div>
            {connection ? (
              <div className="divide-y rounded-lg border">
                {people
                  .filter(
                    (person) =>
                      person.active && (person.monitoringAccepted || person.role === "owner"),
                  )
                  .map((person) => (
                    <ProviderPersonGrant
                      key={`${connection.id}:${person.id}`}
                      person={person}
                      provider={selectedProvider}
                      connection={connection}
                      catalog={catalog.data}
                      catalogError={catalog.error}
                    />
                  ))}
                {!people.some(
                  (person) =>
                    person.active && (person.monitoringAccepted || person.role === "owner"),
                ) ? (
                  <p className="p-4 text-label text-muted-foreground">
                    <Trans>People appear here after they accept the workspace notice.</Trans>
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="rounded-lg border p-4 text-label text-muted-foreground">
                <Trans>Save a company provider key before granting access.</Trans>
              </p>
            )}
          </div>
        </div>
      ) : (
        <p className="rounded-lg border p-4 text-label text-muted-foreground">
          <Trans>No API-key model providers are available in this build.</Trans>
        </p>
      )}
    </section>
  );
}

function ProviderPersonGrant({
  person,
  provider,
  connection,
  catalog,
  catalogError,
}: {
  person: PlatformAdminUser;
  provider: string;
  connection: PlatformModelConnection;
  catalog?: PlatformProviderCatalog;
  catalogError: unknown;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const existing = connection.grants.find((grant) => grant.userId === person.id);
  const [editing, setEditing] = useState(false);
  const [enabled, setEnabled] = useState(existing?.enabled ?? false);
  const [budgeted, setBudgeted] = useState(existing?.countsTowardUserBudget ?? true);
  const [models, setModels] = useState<string[]>(existing?.allowedModelIds ?? []);
  useEffect(() => {
    setEnabled(existing?.enabled ?? false);
    setBudgeted(existing?.countsTowardUserBudget ?? true);
    setModels(existing?.allowedModelIds ?? []);
  }, [existing?.enabled, existing?.countsTowardUserBudget, existing?.allowedModelIds]);
  const save = useSave({
    save: (
      input: {
        userId: string;
        provider: string;
        enabled: boolean;
        allowedModelIds: string[];
        countsTowardUserBudget: boolean;
      },
      rpc,
    ) => rpc.platformAdmin.providers.setGrant(input),
    stale: [queries.platformAdmin.providers.list.key()],
    onSaved: () => setEditing(false),
    onFailed: (error) => toast.error(errorText(error, t`Could not update provider grant`)),
  });
  const modelOptions = catalog?.models ?? [];
  const setModel = (id: string, checked: boolean) =>
    setModels((current) =>
      checked ? [...new Set([...current, id])] : current.filter((model) => model !== id),
    );

  return (
    <div className="space-y-3 p-4" data-testid={`provider-grant-${person.id}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{person.name || person.email}</p>
          <p className="truncate text-label text-muted-foreground">{person.email}</p>
        </div>
        <span className="text-end text-label text-muted-foreground">
          <span className="block">
            {existing?.enabled ? t`Enabled` : existing ? t`Paused` : t`No access`}
          </span>
          {existing ? (
            <span className="block">
              {existing.allowedModelIds.length} {t`models`}
            </span>
          ) : null}
          {existing?.countsTowardUserBudget ? <span className="block">{t`Budgeted`}</span> : null}
        </span>
        <Button
          type="button"
          size="sm"
          variant={editing ? "secondary" : "ghost"}
          onClick={() => setEditing((value) => !value)}
        >
          {editing ? t`Cancel` : t`Edit`}
        </Button>
      </div>
      {editing ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-label">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <Trans>Access enabled</Trans>
            </label>
            <label className="flex items-center gap-2 text-label">
              <input
                type="checkbox"
                checked={budgeted}
                onChange={(event) => setBudgeted(event.target.checked)}
              />
              <Trans>Count toward ${person.monthlyBudgetUsd}/month</Trans>
            </label>
            <Button
              size="sm"
              disabled={save.pending || (enabled && models.length === 0)}
              onClick={() =>
                save.run({
                  userId: person.id,
                  provider,
                  enabled,
                  allowedModelIds: models,
                  countsTowardUserBudget: budgeted,
                })
              }
            >
              <Trans>Save access</Trans>
            </Button>
          </div>
          <p className="text-label text-muted-foreground">
            <Trans>
              Unbudgeted grants are still recorded by source and usage. Personal model keys do not
              use this budget.
            </Trans>
          </p>
          {catalogError ? (
            <p role="alert" className="text-destructive">
              {errorText(catalogError, t`Could not load provider models`)}
            </p>
          ) : null}
          <div className="grid max-h-48 gap-x-5 gap-y-2 overflow-auto rounded-md bg-muted/40 p-3 sm:grid-cols-2">
            {modelOptions.map((model) => (
              <label key={model.id} className="flex min-w-0 items-center gap-2 text-label">
                <input
                  type="checkbox"
                  checked={models.includes(model.id)}
                  onChange={(event) => setModel(model.id, event.target.checked)}
                />
                <span className="min-w-0 flex-1 truncate" title={model.id}>
                  {model.label}
                </span>
                {!model.priced ? (
                  <span className="text-muted-foreground">
                    <Trans>Unpriced</Trans>
                  </span>
                ) : null}
              </label>
            ))}
            {!catalogError && !modelOptions.length ? (
              <p className="text-label text-muted-foreground">
                <Trans>No models are listed for this provider.</Trans>
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
