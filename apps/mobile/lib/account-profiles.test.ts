import { beforeEach, describe, expect, it, vi } from "vitest";

const secureStore = vi.hoisted(() => {
  const values = new Map<string, string>();
  return { values, failKey: "" };
});

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => secureStore.values.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    if (secureStore.failKey === key) throw new Error("secure storage unavailable");
    secureStore.values.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    secureStore.values.delete(key);
  }),
}));

import {
  activeAccountProfileId,
  addAccountProfile,
  credentialsForProfile,
  listAccountProfiles,
  loadAccountProfiles,
  persistActiveAccountProfile,
  profileCredentialStorageKey,
  saveActiveProfileToken,
} from "./account-profiles";

describe("saved account profiles", () => {
  beforeEach(() => {
    secureStore.values.clear();
    secureStore.failKey = "";
  });

  it("upgrades the legacy session then isolates same-host account credentials", async () => {
    const first = await loadAccountProfiles({
      serverUrl: "https://one.example/",
      token: "legacy-session",
      headers: { "x-instance-key": "first" },
    });
    const second = await addAccountProfile("https://one.example", "Second login", {
      "x-instance-key": "second",
    });

    await saveActiveProfileToken(first.id, "first-rotated");
    await persistActiveAccountProfile(second.id);
    await saveActiveProfileToken(second.id, "second-session");

    expect(listAccountProfiles()).toHaveLength(2);
    expect(await credentialsForProfile(first.id)).toEqual({
      token: "first-rotated",
      headers: { "x-instance-key": "first" },
    });
    expect(await credentialsForProfile(second.id)).toEqual({
      token: "second-session",
      headers: { "x-instance-key": "second" },
    });
  });

  it("keeps the current profile selected when the durable switch fails", async () => {
    const first = await loadAccountProfiles({
      serverUrl: "https://one.example",
      token: "first-session",
      headers: {},
    });
    const second = await addAccountProfile("https://two.example", "Second", {});
    secureStore.failKey = "rakazo.active_account_profile";

    await expect(persistActiveAccountProfile(second.id)).rejects.toThrow(
      "secure storage unavailable",
    );
    expect(activeAccountProfileId()).toBe(first.id);
    expect(await credentialsForProfile(second.id)).toEqual({ token: "", headers: {} });
    expect(secureStore.values.has(profileCredentialStorageKey(second.id))).toBe(true);
  });
});
