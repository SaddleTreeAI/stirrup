import { AccountProfileSchema } from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import { defaultApiBase, normalizeApiBase } from "./endpoint";

const PROFILE_LIST_KEY = "rakazo.account_profiles";
const ACTIVE_PROFILE_KEY = "rakazo.active_account_profile";
const PROFILE_SECRET_PREFIX = "rakazo.account_profile.";
const PROFILE_SPACE_PREFIX = "rakazo.account_profile_space.";
const PROFILE_ORGANIZATION_SPACES_PREFIX = "rakazo.account_profile_org_spaces.";

export type AccountProfile = {
  id: string;
  label: string;
  serverUrl: string;
};

export type ProfileCredentials = {
  token: string;
  headers: Record<string, string>;
};

export type LegacyProfileState = {
  serverUrl: string;
  token: string;
  headers: Record<string, string>;
};

let profiles: AccountProfile[] = [];
let activeProfileId: string | null = null;
let ready = false;
let writes: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = writes.then(work, work);
  writes = next.catch(() => undefined);
  return next;
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeAccountProfiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function accountProfilesReady(): boolean {
  return ready;
}

export function listAccountProfiles(): readonly AccountProfile[] {
  return profiles;
}

export function activeAccountProfileId(): string | null {
  return activeProfileId;
}

export function activeAccountProfile(): AccountProfile | null {
  return profiles.find((profile) => profile.id === activeProfileId) ?? null;
}

export function profileCredentialStorageKey(profileId: string): string {
  return `${PROFILE_SECRET_PREFIX}${profileId}`;
}

export function profileSpaceStorageKey(profileId: string): string {
  return `${PROFILE_SPACE_PREFIX}${profileId}`;
}

export function profileOrganizationSpacesStorageKey(profileId: string): string {
  return `${PROFILE_ORGANIZATION_SPACES_PREFIX}${profileId}`;
}

function validProfileList(value: unknown): AccountProfile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = AccountProfileSchema.safeParse(item);
    if (!parsed.success) return [];
    const server = normalizeApiBase(parsed.data.serverUrl);
    if (!server.ok) return [];
    return [{ ...parsed.data, serverUrl: server.url }];
  });
}

async function readProfiles(): Promise<AccountProfile[]> {
  try {
    return validProfileList(JSON.parse((await SecureStore.getItemAsync(PROFILE_LIST_KEY)) ?? "[]"));
  } catch {
    return [];
  }
}

async function writeProfiles(next: AccountProfile[]): Promise<void> {
  const parsed = next.map((profile) => AccountProfileSchema.parse(profile));
  await SecureStore.setItemAsync(PROFILE_LIST_KEY, JSON.stringify(parsed));
  profiles = parsed;
  notify();
}

async function saveCredentials(profileId: string, credentials: ProfileCredentials): Promise<void> {
  await SecureStore.setItemAsync(
    profileCredentialStorageKey(profileId),
    JSON.stringify({ token: credentials.token, headers: credentials.headers }),
  );
}

/** Loads the profile registry and upgrades the old single-server keys on first launch. */
export async function loadAccountProfiles(legacy: LegacyProfileState): Promise<AccountProfile> {
  return enqueue(async () => {
    const saved = await readProfiles();
    let activeId: string | null = null;
    try {
      activeId = await SecureStore.getItemAsync(ACTIVE_PROFILE_KEY);
    } catch {
      // SecureStore failure leaves the in-memory selection available for this launch.
    }

    if (saved.length === 0) {
      const parsed = normalizeApiBase(legacy.serverUrl);
      const initial: AccountProfile = {
        id: newClientId(),
        label: new URL(parsed.ok ? parsed.url : defaultApiBase()).host,
        serverUrl: parsed.ok ? parsed.url : defaultApiBase(),
      };
      await saveCredentials(initial.id, legacy);
      await writeProfiles([initial]);
      try {
        await SecureStore.setItemAsync(ACTIVE_PROFILE_KEY, initial.id);
      } catch {
        // The active profile remains usable in memory; a later launch retries migration.
      }
      activeProfileId = initial.id;
      ready = true;
      notify();
      return initial;
    }

    profiles = saved;
    const active = saved.find((profile) => profile.id === activeId) ?? saved[0];
    if (!active) throw new Error("No saved account profile is available");
    activeProfileId = active.id;
    if (active.id !== activeId) {
      try {
        await SecureStore.setItemAsync(ACTIVE_PROFILE_KEY, active.id);
      } catch {
        // Keep the first valid profile selected for this process.
      }
    }
    ready = true;
    notify();
    return active;
  });
}

export async function readProfileCredentials(profileId: string): Promise<ProfileCredentials> {
  const stored = await SecureStore.getItemAsync(profileCredentialStorageKey(profileId));
  let value: unknown;
  try {
    value = JSON.parse(stored ?? "null");
  } catch {
    return { token: "", headers: {} };
  }
  return {
    token:
      typeof (value as { token?: unknown } | null)?.token === "string"
        ? (value as { token: string }).token
        : "",
    headers:
      (value as { headers?: unknown } | null)?.headers &&
      typeof (value as { headers: unknown }).headers === "object" &&
      !Array.isArray((value as { headers: unknown }).headers)
        ? (value as { headers: Record<string, string> }).headers
        : {},
  };
}

export async function credentialsForProfile(profileId: string): Promise<ProfileCredentials> {
  try {
    return await readProfileCredentials(profileId);
  } catch {
    return { token: "", headers: {} };
  }
}

export async function addAccountProfile(
  serverUrl: string,
  label: string,
  headers: Record<string, string>,
): Promise<AccountProfile> {
  const parsed = normalizeApiBase(serverUrl);
  if (!parsed.ok) throw new Error(parsed.error);
  const cleanLabel = label.trim() || new URL(parsed.url).host;
  return enqueue(async () => {
    const profile: AccountProfile = {
      id: newClientId(),
      label: cleanLabel.slice(0, 80),
      serverUrl: parsed.url,
    };
    await saveCredentials(profile.id, { token: "", headers });
    try {
      await writeProfiles([...profiles, profile]);
    } catch (error) {
      await SecureStore.deleteItemAsync(profileCredentialStorageKey(profile.id)).catch(
        () => undefined,
      );
      throw error;
    }
    return profile;
  });
}

export async function updateAccountProfile(
  profileId: string,
  update: Partial<Pick<AccountProfile, "label" | "serverUrl">>,
): Promise<AccountProfile | null> {
  return enqueue(async () => {
    const index = profiles.findIndex((profile) => profile.id === profileId);
    if (index < 0) return null;
    const current = profiles[index];
    if (!current) return null;
    const parsedUrl = update.serverUrl === undefined ? null : normalizeApiBase(update.serverUrl);
    if (parsedUrl && !parsedUrl.ok) throw new Error(parsedUrl.error);
    const next: AccountProfile = {
      ...current,
      ...(update.label !== undefined ? { label: update.label.trim().slice(0, 80) } : {}),
      ...(parsedUrl?.ok ? { serverUrl: parsedUrl.url } : {}),
    };
    const updated = [...profiles];
    updated[index] = next;
    await writeProfiles(updated);
    return next;
  });
}

/** Active ID is the single durable commit point; credentials are never rewritten on a switch. */
export async function persistActiveAccountProfile(
  profileId: string,
): Promise<AccountProfile | null> {
  return enqueue(async () => {
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) return null;
    await SecureStore.setItemAsync(ACTIVE_PROFILE_KEY, profileId);
    activeProfileId = profileId;
    notify();
    return profile;
  });
}

export async function removeAccountProfile(profileId: string): Promise<AccountProfile | null> {
  return enqueue(async () => {
    const removed = profiles.find((profile) => profile.id === profileId) ?? null;
    if (!removed) return null;
    const next = profiles.filter((profile) => profile.id !== profileId);
    await SecureStore.setItemAsync(PROFILE_LIST_KEY, JSON.stringify(next));
    if (activeProfileId === profileId) {
      const nextActive = next[0] ?? null;
      if (nextActive) await SecureStore.setItemAsync(ACTIVE_PROFILE_KEY, nextActive.id);
      else await SecureStore.deleteItemAsync(ACTIVE_PROFILE_KEY);
      activeProfileId = nextActive?.id ?? null;
    }
    profiles = next;
    await SecureStore.deleteItemAsync(profileCredentialStorageKey(profileId)).catch(
      () => undefined,
    );
    await SecureStore.deleteItemAsync(profileSpaceStorageKey(profileId)).catch(() => undefined);
    await SecureStore.deleteItemAsync(profileOrganizationSpacesStorageKey(profileId)).catch(
      () => undefined,
    );
    notify();
    return removed;
  });
}

export async function saveActiveProfileCredentials(
  profileId: string,
  credentials: ProfileCredentials,
): Promise<void> {
  if (profileId !== activeProfileId)
    throw new Error("The account changed while saving credentials");
  await enqueue(async () => {
    if (profileId !== activeProfileId)
      throw new Error("The account changed while saving credentials");
    await saveCredentials(profileId, credentials);
  });
}

export async function saveActiveProfileToken(profileId: string, token: string): Promise<void> {
  if (profileId !== activeProfileId)
    throw new Error("The account changed while saving credentials");
  await enqueue(async () => {
    if (profileId !== activeProfileId)
      throw new Error("The account changed while saving credentials");
    const previous = await credentialsForProfile(profileId);
    await saveCredentials(profileId, { ...previous, token });
  });
}

export async function saveProfileToken(profileId: string, token: string): Promise<void> {
  await enqueue(async () => {
    const previous = await credentialsForProfile(profileId);
    await saveCredentials(profileId, { ...previous, token });
  });
}
