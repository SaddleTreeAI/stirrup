import path from "node:path";
import type { Session, WebContents, WebFrameMain } from "electron";
import { BrowserWindow, session } from "electron";
import type { StoredDesktopProfile } from "./account-profile-store.js";
import { installServerHeaders } from "./server-request-headers.js";
import { installNotificationPermission } from "./session-permissions.js";
import { normalizeServerUrl, sessionPartitionForServerUrl } from "./setup-config.js";

const listeners = new Map<string, { win: BrowserWindow; stopPermission: () => void }>();

export function notificationProfileForSender(
  profileWindows: ReadonlyMap<string, { win: BrowserWindow }>,
  sender: WebContents,
): string | undefined {
  for (const [profileId, listener] of profileWindows) {
    if (!listener.win.isDestroyed() && listener.win.webContents === sender) return profileId;
  }
  return undefined;
}

export function profileForNotificationSender(sender: WebContents): string | undefined {
  return notificationProfileForSender(listeners, sender);
}

export function trustedNotificationProfileForSender(
  profileWindows: ReadonlyMap<string, { win: BrowserWindow }>,
  profiles: StoredDesktopProfile[],
  activeProfileId: string | null,
  sender: WebContents,
  senderFrame: WebFrameMain | null,
): string | undefined {
  if (sender.isDestroyed() || !senderFrame || senderFrame !== sender.mainFrame) return undefined;
  const profileId = notificationProfileForSender(profileWindows, sender);
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile || profile.id === activeProfileId) return undefined;
  try {
    return normalizeServerUrl(sender.getURL()) === profile.serverUrl ? profileId : undefined;
  } catch {
    return undefined;
  }
}

export function trustedProfileForNotificationSender(
  profiles: StoredDesktopProfile[],
  activeProfileId: string | null,
  sender: WebContents,
  senderFrame: WebFrameMain | null,
): string | undefined {
  return trustedNotificationProfileForSender(
    listeners,
    profiles,
    activeProfileId,
    sender,
    senderFrame,
  );
}

/** Hidden, unprivileged app windows keep each inactive account's server stream connected. */
export async function keepProfileNotifications(
  profiles: StoredDesktopProfile[],
  activeId: string | null,
) {
  const wanted = new Map(
    profiles
      .filter((profile) => profile.id !== activeId && profile.setup.mode !== "new")
      .map((profile) => [profile.id, profile]),
  );
  for (const [profileId, listener] of listeners) {
    if (wanted.has(profileId)) continue;
    listener.stopPermission();
    if (!listener.win.isDestroyed()) listener.win.destroy();
    listeners.delete(profileId);
  }
  for (const [profileId, profile] of wanted) {
    const existing = listeners.get(profileId);
    if (existing && !existing.win.isDestroyed()) continue;
    const partition = profile.legacySession
      ? null
      : sessionPartitionForServerUrl(profile.serverUrl, profile.id);
    const targetSession: Session = partition
      ? session.fromPartition(partition)
      : session.defaultSession;
    const win = new BrowserWindow({
      show: false,
      width: 480,
      height: 320,
      webPreferences: {
        preload: path.join(import.meta.dirname, "profile-notification-preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        ...(partition ? { partition } : {}),
      },
    });
    const stopPermission = installNotificationPermission(
      targetSession,
      win.webContents,
      profile.serverUrl,
    );
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    if (profile.setup.headers && Object.keys(profile.setup.headers).length > 0)
      installServerHeaders(targetSession, profile.setup, () => win.webContents.id);
    win.on("closed", () => {
      stopPermission();
      if (listeners.get(profileId)?.win === win) listeners.delete(profileId);
    });
    listeners.set(profileId, { win, stopPermission });
    try {
      await win.loadURL(profile.serverUrl);
    } catch {
      // An inactive host may be offline. Its app will reconnect when it is available.
    }
  }
}

export function closeProfileNotificationWindows() {
  for (const listener of listeners.values()) {
    listener.stopPermission();
    if (!listener.win.isDestroyed()) listener.win.destroy();
  }
  listeners.clear();
}
