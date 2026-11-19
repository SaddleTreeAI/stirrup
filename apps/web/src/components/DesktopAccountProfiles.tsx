import { Trans, useLingui } from "@lingui/react/macro";
import type { AccountProfile } from "@rakazo/contracts";
import { Button, Dialog, DialogContent, DialogFooter, DialogTitle, Input } from "@rakazo/ui-web";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { desktopBridge } from "../lib/desktop";
import { ConfirmDialog } from "./ConfirmDialog";

export type DesktopProfileAction = {
  kind: "rename" | "remove";
  profile: AccountProfile;
};

export function DesktopAccountProfiles({
  onAction,
}: {
  onAction: (action: DesktopProfileAction) => void;
}) {
  const { t } = useLingui();
  const bridge = desktopBridge();
  const [state, setState] = useState<{
    activeProfileId: string | null;
    profiles: AccountProfile[];
  } | null>(null);
  const [error, setError] = useState<"load" | "select" | null>(null);

  const profiles = bridge?.profiles;
  useEffect(() => {
    let mounted = true;
    void profiles?.state().then(
      (next) => {
        if (mounted) setState(next);
      },
      () => {
        if (mounted) setError("load");
      },
    );
    return () => {
      mounted = false;
    };
  }, [profiles]);

  if (!profiles) return null;
  const select = async (id: string) => {
    setError(null);
    try {
      if (await profiles.select(id)) {
        setState(await profiles.state());
        return;
      }
    } catch {
      // A desktop window may go away while the server switch is in progress.
    }
    setError("select");
  };

  return (
    <div className="flex flex-col gap-1 py-1" data-testid="desktop-account-profiles">
      {state?.profiles.map((profile) => {
        const active = profile.id === state.activeProfileId;
        return (
          <div key={profile.id} className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              className="flex min-w-0 flex-1 flex-col rounded-md px-2 py-1.5 text-start hover:bg-accent disabled:opacity-100"
              disabled={active}
              aria-current={active ? "true" : undefined}
              onClick={() => void select(profile.id)}
            >
              <span className="truncate text-body">{profile.label}</span>
              <span className="truncate text-label text-muted-foreground">{profile.serverUrl}</span>
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Rename ${profile.label}`}
              title={t`Rename`}
              className="shrink-0 text-muted-foreground"
              onClick={() => onAction({ kind: "rename", profile })}
            >
              <Pencil aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Remove ${profile.label}`}
              title={t`Remove`}
              disabled={active || state.profiles.length < 2}
              className="shrink-0 text-muted-foreground"
              onClick={() => onAction({ kind: "remove", profile })}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        );
      })}
      <button
        type="button"
        className="flex items-center gap-2 rounded-md px-2 py-2 text-start text-body hover:bg-accent"
        onClick={() => void bridge?.server?.addProfile?.()}
      >
        <Plus size={15} aria-hidden="true" />
        <Trans>Add account</Trans>
      </button>
      {error ? (
        <p role="status" className="px-2 text-label text-destructive">
          {error === "load" ? t`Could not load saved accounts.` : t`Could not open this account.`}
        </p>
      ) : null}
    </div>
  );
}

export function DesktopProfileDialog({
  action: { kind, profile },
  onClose,
}: {
  action: DesktopProfileAction;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [label, setLabel] = useState(profile.label);
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const pending = status === "saving";
  const save = async () => {
    const profiles = desktopBridge()?.profiles;
    if (!profiles || pending) return;
    setStatus("saving");
    try {
      const saved =
        kind === "rename"
          ? await profiles.rename(profile.id, label.trim())
          : await profiles.remove(profile.id);
      if (saved) {
        onClose();
        return;
      }
    } catch {
      // A rejected desktop request is shown next to the action so it can be retried.
    }
    setStatus("error");
  };
  if (kind === "remove") {
    return (
      <ConfirmDialog
        title={t`Remove ${profile.label} from this device?`}
        confirmLabel={<Trans>Remove</Trans>}
        onCancel={onClose}
        onConfirm={() => void save()}
        busy={pending}
        error={status === "error" ? t`Could not remove this account.` : null}
      />
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogTitle>
          <Trans>Rename account</Trans>
        </DialogTitle>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (label.trim()) void save();
          }}
        >
          <Input
            aria-label={t`Account name`}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={80}
            disabled={pending}
          />
          {status === "error" ? (
            <p role="alert" className="text-destructive">
              <Trans>Could not rename this account.</Trans>
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={pending || !label.trim()}>
              <Trans>Save</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
