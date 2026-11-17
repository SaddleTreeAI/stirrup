import { Trans, useLingui } from "@lingui/react/macro";
import type { AccountProfile } from "@rakazo/contracts";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { desktopBridge } from "../lib/desktop";

export function DesktopAccountProfiles() {
  const { t } = useLingui();
  const bridge = desktopBridge();
  const [state, setState] = useState<{
    activeProfileId: string | null;
    profiles: AccountProfile[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void bridge?.profiles?.state().then((next) => {
      if (mounted) setState(next);
    });
    return () => {
      mounted = false;
    };
  }, [bridge]);

  if (!bridge?.profiles || !state) return null;
  const setProfileState = async (run: () => Promise<boolean>, failure: string) => {
    setError(null);
    try {
      if (!(await run())) setError(failure);
    } catch {
      setError(failure);
    }
  };
  const rename = (profile: AccountProfile) => {
    const label = window.prompt(t`Account name`, profile.label);
    if (label === null) return;
    void setProfileState(
      () => bridge.profiles!.rename(profile.id, label),
      t`Could not rename this account.`,
    ).then(async () => setState(await bridge.profiles!.state()));
  };
  const remove = (profile: AccountProfile) => {
    if (!window.confirm(t`Remove ${profile.label} from this device?`)) return;
    void setProfileState(
      () => bridge.profiles!.remove(profile.id),
      t`Could not remove this account.`,
    ).then(async () => setState(await bridge.profiles!.state()));
  };

  return (
    <div className="flex flex-col gap-1 py-1" data-testid="desktop-account-profiles">
      {state.profiles.map((profile) => {
        const active = profile.id === state.activeProfileId;
        return (
          <div key={profile.id} className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              className="flex min-w-0 flex-1 flex-col rounded-md px-2 py-1.5 text-start hover:bg-accent disabled:opacity-100"
              disabled={active}
              aria-current={active ? "true" : undefined}
              onClick={() => {
                void setProfileState(
                  () => bridge.profiles!.select(profile.id),
                  t`Could not open this account.`,
                ).then(async () => setState(await bridge.profiles!.state()));
              }}
            >
              <span className="truncate text-sm">{profile.label}</span>
              <span className="truncate text-xs text-muted-foreground">{profile.serverUrl}</span>
            </button>
            <button
              type="button"
              aria-label={t`Rename ${profile.label}`}
              title={t`Rename`}
              className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => rename(profile)}
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={t`Remove ${profile.label}`}
              title={t`Remove`}
              disabled={active || state.profiles.length < 2}
              className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
              onClick={() => remove(profile)}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="flex items-center gap-2 rounded-md px-2 py-2 text-start text-sm hover:bg-accent"
        onClick={() => void bridge.server?.addProfile?.()}
      >
        <Plus size={15} aria-hidden="true" />
        <Trans>Add account</Trans>
      </button>
      {error ? (
        <p role="status" className="px-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
