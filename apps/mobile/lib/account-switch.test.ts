import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => disk.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    disk.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    disk.delete(key);
  }),
}));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => true),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));

import {
  activeAccountProfileId,
  addAccountProfile,
  credentialsForProfile,
  saveProfileToken,
} from "./account-profiles";
import { authHeaders, currentApiBase } from "./api";
import { activateAccountProfile, loadApiBase } from "./api-server";
import { currentSessionGeneration, loadSessionToken, restoreSessionToken } from "./session";

describe("mobile saved profile switching", () => {
  beforeEach(async () => {
    disk.clear();
    await loadApiBase();
    await restoreSessionToken("first-session");
  });

  it("switches same-host accounts without sharing tokens or custom headers", async () => {
    const firstId = activeAccountProfileId();
    if (!firstId) throw new Error("The migrated profile is missing");
    const second = await addAccountProfile(currentApiBase(), "Second login", {
      "CF-Access-Client-Id": "second-access-id",
    });
    await saveProfileToken(second.id, "second-session");
    const generation = currentSessionGeneration();

    await expect(activateAccountProfile(second.id)).resolves.toMatchObject({ ok: true });

    expect(activeAccountProfileId()).toBe(second.id);
    expect(currentApiBase()).toBe("http://127.0.0.1:3100");
    expect(currentSessionGeneration()).toBeGreaterThan(generation);
    expect(await loadSessionToken()).toBe("second-session");
    expect(await authHeaders(null)).toMatchObject({
      authorization: "Bearer second-session",
      "CF-Access-Client-Id": "second-access-id",
    });
    expect(await credentialsForProfile(firstId)).toEqual({ token: "first-session", headers: {} });
  });
});
