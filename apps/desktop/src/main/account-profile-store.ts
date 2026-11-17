import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { AccountProfile, DesktopSetup } from "@rakazo/contracts";
import { AccountProfileSchema } from "@rakazo/contracts";
import { parseSetupInput } from "./setup-config.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

const FILE_NAME = "account-profiles.json";
const MAX_BYTES = 256 * 1024;

export interface StoredDesktopProfile extends AccountProfile {
  setup: DesktopSetup;
  /** The first saved setup keeps the origin's pre-profile cookie partition. */
  legacySession: boolean;
}

export interface DesktopProfileStore {
  version: 1;
  activeProfileId: string;
  profiles: StoredDesktopProfile[];
}

export function accountProfileFilePath(userDataDir: string): string {
  return path.join(userDataDir, FILE_NAME);
}

function parseStoredProfile(value: unknown): StoredDesktopProfile | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const metadata = AccountProfileSchema.safeParse({
    id: record.id,
    label: record.label,
    serverUrl: record.serverUrl,
  });
  if (!metadata.success || typeof record.legacySession !== "boolean") return null;
  const setup = parseSetupInput(record.setup);
  if (setup === null || setup.serverUrl !== metadata.data.serverUrl) return null;
  return {
    ...metadata.data,
    setup,
    legacySession: record.legacySession,
  };
}

export function parseDesktopProfileStore(value: unknown): DesktopProfileStore | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.activeProfileId !== "string" ||
    !Array.isArray(record.profiles)
  )
    return null;
  if (record.profiles.length < 1 || record.profiles.length > 100) return null;
  const profiles = record.profiles.map(parseStoredProfile);
  if (profiles.some((profile) => profile === null)) return null;
  const validProfiles = profiles as StoredDesktopProfile[];
  if (new Set(validProfiles.map((profile) => profile.id)).size !== validProfiles.length)
    return null;
  if (!validProfiles.some((profile) => profile.id === record.activeProfileId)) return null;
  return { version: 1, activeProfileId: record.activeProfileId, profiles: validProfiles };
}

export async function readDesktopProfileStore(
  userDataDir: string,
): Promise<DesktopProfileStore | null> {
  const raw = await readPrivateFile(accountProfileFilePath(userDataDir), MAX_BYTES);
  if (raw === null) return null;
  try {
    return parseDesktopProfileStore(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function writeDesktopProfileStore(
  userDataDir: string,
  store: DesktopProfileStore,
): Promise<void> {
  await writePrivateFile(
    accountProfileFilePath(userDataDir),
    `${JSON.stringify(store, null, 2)}\n`,
  );
}

export async function clearDesktopProfileStore(userDataDir: string): Promise<void> {
  await rm(accountProfileFilePath(userDataDir), { force: true });
}

export function profileFromSetup(setup: DesktopSetup, legacySession = false): StoredDesktopProfile {
  const host = new URL(setup.serverUrl).hostname;
  return {
    id: randomUUID(),
    label: host,
    serverUrl: setup.serverUrl,
    setup,
    legacySession,
  };
}

export function safeProfileLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (
    [...label].some(
      (character) => character.codePointAt(0)! < 32 || character.codePointAt(0)! === 127,
    )
  )
    return null;
  return label.length > 0 && label.length <= 80 ? label : null;
}
