import { t } from "@lingui/core/macro";
import * as SecureStore from "expo-secure-store";
import {
  activeAccountProfile,
  activeAccountProfileId,
  addAccountProfile,
  credentialsForProfile,
  removeAccountProfile as deleteAccountProfile,
  listAccountProfiles,
  loadAccountProfiles,
  persistActiveAccountProfile,
  profileOrganizationSpacesStorageKey,
  profileSpaceStorageKey,
} from "./account-profiles";
import type { PendingSignOut } from "./api";
import {
  clearStoredValue,
  currentApiBase,
  currentSpaceSelectionGeneration,
  flushPendingSignOut,
  nextSpaceSelectionRequest,
  queueEndpointChange,
  rawSelectedSpaceId,
  resumeSelectedSpaceNotifications,
  SPACE_KEY,
  SPACE_ROLLBACK_KEY,
  savePendingSignOut,
  selectedSpaceId,
  setCachedApiBase,
  setSelectedSpace,
  spaceSelectionSeq,
  writeStoredValue,
} from "./api";
import type { EndpointResult } from "./endpoint";
import { defaultApiBase, normalizeApiBase } from "./endpoint";
import { API_BASE_STORAGE_KEY as ENDPOINT_KEY } from "./server-config";
import {
  loadProfileServerHeaders,
  loadServerHeaders,
  saveServerHeaders,
  serverHeaders,
} from "./server-headers";
import { activateSavedProfileSession } from "./session";

/** The Space last used in each organization on this device, by organization id. */
const ORGANIZATION_SPACES_KEY = "rakazo.org_spaces";
const confirmedSpaceSwitchListeners = new Set<() => void>();
/** Fires when a selection change to another Space is confirmed durable; a
 * rollback after a failed switch, or selecting the same Space again, does not. */
export function subscribeConfirmedSpaceSwitch(listener: () => void): () => void {
  confirmedSpaceSwitchListeners.add(listener);
  return () => {
    confirmedSpaceSwitchListeners.delete(listener);
  };
}
function noteConfirmedSpaceSwitch(): void {
  for (const listener of [...confirmedSpaceSwitchListeners]) listener();
}
export async function loadApiBase() {
  let apiBase = defaultApiBase();
  try {
    const stored = await SecureStore.getItemAsync(ENDPOINT_KEY);
    if (stored) {
      const parsed = normalizeApiBase(stored);
      if (parsed.ok) {
        apiBase = parsed.url;
      }
    }
  } catch {
    // SecureStore is unavailable in some test / web hosts.
  }
  await loadServerHeaders(apiBase);
  let legacyToken = "";
  try {
    legacyToken = (await SecureStore.getItemAsync("rakazo.session_token")) ?? "";
  } catch {
    // The old session remains unavailable, as before.
  }
  const active = await loadAccountProfiles({
    serverUrl: apiBase,
    token: legacyToken,
    headers: serverHeaders(apiBase),
  }).catch(() => null);
  if (active) apiBase = active.serverUrl;
  setCachedApiBase(apiBase);
  if (active) {
    await loadServerHeaders(apiBase);
    const credentials = await credentialsForProfile(active.id);
    try {
      await SecureStore.setItemAsync("rakazo.api_base", active.serverUrl);
      await SecureStore.setItemAsync("rakazo.session_token", credentials.token);
      await SecureStore.setItemAsync(
        "rakazo.server_headers",
        JSON.stringify({ apiBase: active.serverUrl, headers: credentials.headers }),
      );
    } catch {
      // Legacy keys are a compatibility mirror; per-profile credentials remain authoritative.
    }
  }
  try {
    const profileSpaceKey = active ? profileSpaceStorageKey(active.id) : null;
    const profileSpace = profileSpaceKey ? await SecureStore.getItemAsync(profileSpaceKey) : null;
    const storedSpace = profileSpace ?? (await SecureStore.getItemAsync(SPACE_KEY)) ?? "";
    if (profileSpaceKey && profileSpace === null && storedSpace) {
      await SecureStore.setItemAsync(profileSpaceKey, storedSpace).catch(() => undefined);
    }
    setSelectedSpace(storedSpace);
    // A deletion fallback must override the now-invalid saved Space even when
    // the device failed to replace that value before the previous process exited.
    await recoverSpaceRollback(apiBase);
  } catch {
    // Keep any in-memory selection when SecureStore is temporarily unavailable.
  }
  // A revocation left pending by an earlier sign-out or server switch retries on this launch.
  void flushPendingSignOut(true);
  return currentApiBase();
}
export async function selectSpace(id: string) {
  const requestGeneration = nextSpaceSelectionRequest();
  if (!(await clearStoredValue(SPACE_ROLLBACK_KEY))) return false;
  // Rollback cleanup is the first await. A newer selection may have claimed
  // the live space while this call was still deleting the rollback record.
  if (requestGeneration !== spaceSelectionSeq()) return false;
  // Claim memory before persisting: recovery paths reconcile against the
  // in-memory selection, so a durable write must never precede its owner.
  const previousSpaceId = rawSelectedSpaceId();
  setSelectedSpace(id);
  // Generation ownership distinguishes A→B→A from "we still own this claim":
  // an ID-only check would treat a later same-id selection as ours.
  const claimGeneration = currentSpaceSelectionGeneration();
  try {
    await SecureStore.setItemAsync(SPACE_KEY, id);
    const profileId = activeAccountProfileId();
    if (profileId) await SecureStore.setItemAsync(profileSpaceStorageKey(profileId), id);
    // Our write may have landed stale behind a newer overlapping selection's
    // write. Re-assert the live selection best-effort so durable converges
    // to it; each selector heals at most once, so overlapping chains settle
    // on the latest claim. Never delete here: a missing memory owner means
    // another path (recovery, sign-out) owns cleanup.
    const liveSpaceId = rawSelectedSpaceId();
    if (liveSpaceId && liveSpaceId !== id) {
      await writeStoredValue(SPACE_KEY, liveSpaceId);
    }
  } catch {
    // Roll back the claim and heal durable state: a concurrent recovery may
    // have persisted the rolled-back id after reading it, which would leave
    // restart opening a Space the live session is not using. A newer
    // overlapping selection owns both by now, so only heal a claim we hold.
    if (rawSelectedSpaceId() === id && currentSpaceSelectionGeneration() === claimGeneration) {
      setSelectedSpace(previousSpaceId);
      const rollbackGeneration = currentSpaceSelectionGeneration();
      if (previousSpaceId) await writeStoredValue(SPACE_KEY, previousSpaceId);
      if (previousSpaceId)
        await resumeSelectedSpaceNotifications(previousSpaceId, rollbackGeneration);
    }
    return false;
  }
  // Playback belongs to the conversation being left; the listener in voice.ts
  // stops it once a switch to another Space is confirmed. A fallback that
  // failed to persist left its origin pending; this confirmed switch consumes
  // it, so the fallback's retry cannot stop this Space's later playback.
  if ((pendingFallbackSwitchFrom ?? previousSpaceId) !== id) noteConfirmedSpaceSwitch();
  pendingFallbackSwitchFrom = null;
  await resumeSelectedSpaceNotifications(id, claimGeneration);
  return true;
}
/** Keep requests usable after the server deleted the selected Space but native
 * storage could not replace it. Neutralize any same-endpoint rollback before
 * writing the replacement selection so a cleanup failure cannot leave the new
 * id beside a stale record that recoverSpaceRollback would prefer on restart. */
/** The Space the user was actually on before a fallback adoption that has not
 * landed yet; a retry that persists must still count as leaving it. */
let pendingFallbackSwitchFrom: string | null = null;
export async function adoptDeletedSpaceFallback(id: string): Promise<boolean> {
  const previousSpaceId = rawSelectedSpaceId();
  if (pendingFallbackSwitchFrom === null && previousSpaceId !== id) {
    pendingFallbackSwitchFrom = previousSpaceId;
  }
  setSelectedSpace(id);
  // Same ownership as selectSpace: a newer selection during the token read wins.
  const claimGeneration = currentSpaceSelectionGeneration();
  // Neutralize any same-endpoint rollback before writing SPACE_KEY. Writing the
  // selection first can leave it beside a stale record that recoverSpaceRollback
  // would prefer on restart if later cleanup fails.
  const rollbackNeutralized =
    (await clearStoredValue(SPACE_ROLLBACK_KEY)) || (await saveSpaceRollback(id));
  // Playback belongs to the conversation being left; the fallback too is a
  // confirmed switch once it durably adopts another Space. A failed attempt
  // already claimed the replacement in memory, so the Space remembered before
  // the first attempt, not the claim, decides whether one was left behind.
  if (rollbackNeutralized && (await writeStoredValue(SPACE_KEY, id))) {
    // SPACE_KEY is authoritative; drop a rollback we may have written only to
    // overwrite a stale record (best-effort).
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    if ((pendingFallbackSwitchFrom ?? previousSpaceId) !== id) noteConfirmedSpaceSwitch();
    pendingFallbackSwitchFrom = null;
    await resumeSelectedSpaceNotifications(id, claimGeneration);
    return true;
  }
  // Clear before saving recovery: an empty selection lets startup resolve the
  // server default even when the recovery record cannot be written.
  const staleSelectionCleared = await clearStoredValue(SPACE_KEY);
  const recoverySaved = await saveSpaceRollback(id);
  await resumeSelectedSpaceNotifications(id, claimGeneration);
  // Only treat a cleared selection as durable success when no same-endpoint
  // rollback remains to override it after restart.
  const durable =
    recoverySaved || (staleSelectionCleared && (await clearStoredValue(SPACE_ROLLBACK_KEY)));
  if (durable && (pendingFallbackSwitchFrom ?? previousSpaceId) !== id) {
    noteConfirmedSpaceSwitch();
  }
  if (durable) pendingFallbackSwitchFrom = null;
  return durable;
}
export async function selectInitialSpace(id: string) {
  if (selectedSpaceId()) return true;
  return selectSpace(id);
}
export async function loadOrganizationSpaces(): Promise<Record<string, string>> {
  try {
    const profileId = activeAccountProfileId();
    const parsed: unknown = JSON.parse(
      (profileId
        ? await SecureStore.getItemAsync(profileOrganizationSpacesStorageKey(profileId))
        : null) ||
        (await SecureStore.getItemAsync(ORGANIZATION_SPACES_KEY)) ||
        "{}",
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  } catch {
    return {};
  }
}
export async function rememberOrganizationSpace(
  organizationId: string,
  spaceId: string,
): Promise<void> {
  const spaces = await loadOrganizationSpaces();
  const next = JSON.stringify({ ...spaces, [organizationId]: spaceId });
  const profileId = activeAccountProfileId();
  if (profileId) {
    await SecureStore.setItemAsync(profileOrganizationSpacesStorageKey(profileId), next);
  }
  await writeStoredValue(ORGANIZATION_SPACES_KEY, next);
}
export async function clearSpace(): Promise<boolean> {
  const profileId = activeAccountProfileId();
  if (profileId) {
    await clearStoredValue(profileOrganizationSpacesStorageKey(profileId));
    await clearStoredValue(profileSpaceStorageKey(profileId));
  }
  const organizationsCleared = await clearStoredValue(ORGANIZATION_SPACES_KEY);
  const spaceCleared = await clearStoredValue(SPACE_KEY);
  const rollbackCleared = await clearStoredValue(SPACE_ROLLBACK_KEY);
  if (!organizationsCleared || !spaceCleared || !rollbackCleared) return false;
  setSelectedSpace("");
  return true;
}
/**
 * Hangs up an active call while its session can still authorize the hang-up. Set by the call
 * module; a server switch runs it before it discards the old server's session, which would
 * otherwise leave the old server holding an answered call with no marker or wrap-up.
 */
let hangUpBeforeCredentialsCleared: (() => Promise<void>) | undefined;
/** Registers (or clears) the hang-up that runs before an endpoint change clears credentials. */
export function configureSessionEndHangUp(hangUp: (() => Promise<void>) | undefined): void {
  hangUpBeforeCredentialsCleared = hangUp;
}
async function saveSpaceRollback(spaceId: string): Promise<boolean> {
  return writeStoredValue(
    SPACE_ROLLBACK_KEY,
    JSON.stringify({ apiBase: currentApiBase(), spaceId }),
  );
}
async function recoverSpaceRollback(apiBase: string) {
  const stored = await SecureStore.getItemAsync(SPACE_ROLLBACK_KEY);
  if (!stored) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  const rollback = parsed as { apiBase?: unknown; spaceId?: unknown };
  if (rollback.apiBase !== apiBase || typeof rollback.spaceId !== "string" || !rollback.spaceId) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  setSelectedSpace(rollback.spaceId);
  if (await writeStoredValue(SPACE_KEY, rollback.spaceId)) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  // Could not replace the selection yet. Drop the deleted id so startup RPCs
  // are not scoped to an inaccessible Space; keep the recovery record.
  await clearStoredValue(SPACE_KEY);
}
export async function saveApiBase(
  input: string,
  headers: Record<string, string> = {},
  options: { label?: string; createProfile?: boolean } = {},
): Promise<EndpointResult> {
  const parsed = normalizeApiBase(input);
  if (!parsed.ok) return parsed;
  if (options.createProfile || parsed.url !== currentApiBase()) {
    const profile = await addAccountProfile(
      parsed.url,
      options.label || new URL(parsed.url).host,
      headers,
    );
    const switched = await activateAccountProfile(profile.id);
    return switched.ok ? parsed : switched;
  }
  if (parsed.url === defaultApiBase() && Object.keys(headers).length === 0) return resetApiBase();
  if (!(await saveServerHeaders(parsed.url, headers))) {
    return { ok: false, error: t`Could not save the server URL` };
  }
  return parsed;
}

/** Switches profile credentials and server as one in-memory request epoch. */
export async function activateAccountProfile(profileId: string): Promise<EndpointResult> {
  const profile = listAccountProfiles().find((item) => item.id === profileId);
  if (!profile) return { ok: false, error: t`That account is no longer available.` };
  if (profileId === activeAccountProfileId()) return { ok: true, url: profile.serverUrl };
  return queueEndpointChange(profile.serverUrl, async () => {
    await hangUpBeforeCredentialsCleared?.().catch(() => undefined);
    const previousProfile = activeAccountProfile();
    if (previousProfile) {
      const previousSpace = rawSelectedSpaceId();
      if (previousSpace) {
        await writeStoredValue(profileSpaceStorageKey(previousProfile.id), previousSpace);
      }
      try {
        const organizations = await SecureStore.getItemAsync(ORGANIZATION_SPACES_KEY);
        if (organizations) {
          await SecureStore.setItemAsync(
            profileOrganizationSpacesStorageKey(previousProfile.id),
            organizations,
          );
        }
      } catch {
        // Space preferences are best-effort; credentials are still switched atomically below.
      }
    }
    const nextSpace = await SecureStore.getItemAsync(profileSpaceStorageKey(profileId)).catch(
      () => null,
    );
    const nextOrganizations = await SecureStore.getItemAsync(
      profileOrganizationSpacesStorageKey(profileId),
    ).catch(() => null);
    await loadProfileServerHeaders(profileId, profile.serverUrl);
    let selected: Awaited<ReturnType<typeof persistActiveAccountProfile>>;
    try {
      selected = await persistActiveAccountProfile(profileId);
    } catch {
      await loadServerHeaders(currentApiBase());
      return { ok: false, error: t`Could not save the account selection.` };
    }
    if (!selected) {
      await loadServerHeaders(currentApiBase());
      return { ok: false, error: t`That account is no longer available.` };
    }
    setCachedApiBase(selected.serverUrl);
    setSelectedSpace(nextSpace ?? "");
    // This synchronously advances the request epoch before the first await, so
    // no request can mix the new token with the previous profile's cache state.
    const sessionSwitch = activateSavedProfileSession(selected.id);
    await writeStoredValue(SPACE_KEY, nextSpace ?? "");
    if (nextOrganizations) {
      await writeStoredValue(ORGANIZATION_SPACES_KEY, nextOrganizations);
    } else {
      await clearStoredValue(ORGANIZATION_SPACES_KEY);
    }
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    await sessionSwitch;
    const credentials = await credentialsForProfile(selected.id);
    try {
      await SecureStore.setItemAsync("rakazo.api_base", selected.serverUrl);
      await SecureStore.setItemAsync("rakazo.session_token", credentials.token);
      await SecureStore.setItemAsync(
        "rakazo.server_headers",
        JSON.stringify({ apiBase: selected.serverUrl, headers: credentials.headers }),
      );
    } catch {
      // Legacy mirrors support native extensions; the profile store remains authoritative.
    }
    if (nextSpace) {
      await resumeSelectedSpaceNotifications(nextSpace, currentSpaceSelectionGeneration());
    }
    return { ok: true, url: selected.serverUrl };
  });
}

export async function removeSavedAccountProfile(profileId: string): Promise<boolean> {
  const profiles = listAccountProfiles();
  if (profiles.length < 2) return false;
  const removed = profiles.find((profile) => profile.id === profileId);
  if (!removed) return false;
  if (profileId === activeAccountProfileId()) {
    const replacement = profiles.find((profile) => profile.id !== profileId);
    if (!replacement || !(await activateAccountProfile(replacement.id)).ok) return false;
  }
  const credentials = await credentialsForProfile(profileId);
  if (credentials.token) {
    const pendingSignOut: PendingSignOut = {
      apiBase: removed.serverUrl,
      token: credentials.token,
      headers: credentials.headers,
      recordedAt: Date.now(),
    };
    if (!(await savePendingSignOut(pendingSignOut))) return false;
    void flushPendingSignOut().catch(() => undefined);
  }
  return (await deleteAccountProfile(profileId)) !== null;
}
export async function resetApiBase(): Promise<EndpointResult> {
  const url = defaultApiBase();
  const existing = listAccountProfiles().find((profile) => profile.serverUrl === url);
  if (existing) return activateAccountProfile(existing.id);
  const profile = await addAccountProfile(url, new URL(url).host, {});
  return activateAccountProfile(profile.id);
}
