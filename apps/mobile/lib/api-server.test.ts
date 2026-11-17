vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeAccountProfileId,
  addAccountProfile,
  credentialsForProfile,
  listAccountProfiles,
  profileCredentialStorageKey,
  saveProfileToken,
} from "./account-profiles";
import { authHeaders, currentApiBase, rpc, selectedSpaceId, spaceSelectionSeq } from "./api.js";
import {
  activateAccountProfile,
  adoptDeletedSpaceFallback,
  loadApiBase,
  removeSavedAccountProfile,
  saveApiBase,
  selectSpace,
} from "./api-server.js";
import { resumeLiveNotifications } from "./live-notifications.js";
import { restoreSessionToken } from "./session.js";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

import {
  jsonResponse,
  mockSecureStore,
  pendingSignOutRecords,
  rpcErrorResponse,
} from "./api-test-helpers";

async function mockProfileStore(store: Map<string, string>): Promise<void> {
  mockSecureStore(store);
  await loadApiBase();
}

describe("mobile API server and Space selection", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    vi.mocked(resumeLiveNotifications).mockClear();
    await mockProfileStore(new Map());
    await restoreSessionToken("");
  });

  it("shares the selected space with direct API requests", async () => {
    await restoreSessionToken("session-token");
    await selectSpace("space-support");

    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });
  });

  it("does not switch spaces when the selection cannot be persisted", async () => {
    await expect(selectSpace("space-support")).resolves.toBe(true);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
    });

    await expect(selectSpace("space-social")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-support");

    vi.mocked(SecureStore.setItemAsync).mockReset();
    await selectSpace("");
  });

  it("does not switch spaces when stale recovery cannot be cleared", async () => {
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback" && value === "") throw new Error("device locked");
    });

    await expect(selectSpace("space-social")).resolves.toBe(false);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith("rakazo.space_id", "space-social");
    expect(selectedSpaceId()).toBe("space-support");

    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    await selectSpace("");
  });

  // These profile regressions replace the old endpoint-switch/revoke race cases:
  // a server/account switch must keep both credential sets; only explicit removal
  // schedules revocation, and it must use the removed profile's origin and headers.
  it("keeps credentials and Space preferences isolated across same-host accounts", async () => {
    const firstId = activeAccountProfileId();
    if (!firstId) throw new Error("The migrated profile is missing");
    await saveProfileToken(firstId, "first-token");
    await selectSpace("space-first");
    const second = await addAccountProfile(currentApiBase(), "Second login", {
      "CF-Access-Client-Id": "second-access",
    });
    await saveProfileToken(second.id, "second-token");
    await activateAccountProfile(second.id);
    await selectSpace("space-second");

    await expect(activateAccountProfile(firstId)).resolves.toMatchObject({ ok: true });
    await expect(authHeaders()).resolves.toMatchObject({
      authorization: "Bearer first-token",
      "x-rakazo-space-id": "space-first",
    });
    await expect(activateAccountProfile(second.id)).resolves.toMatchObject({ ok: true });
    await expect(authHeaders()).resolves.toMatchObject({
      authorization: "Bearer second-token",
      "CF-Access-Client-Id": "second-access",
      "x-rakazo-space-id": "space-second",
    });
    expect(await credentialsForProfile(firstId)).toEqual({ token: "first-token", headers: {} });
  });

  it("switches hosts without ever sending the old token to the new host", async () => {
    const store = new Map<string, string>();
    await mockProfileStore(store);
    const oldId = activeAccountProfileId();
    if (!oldId) throw new Error("The migrated profile is missing");
    await saveProfileToken(oldId, "old-host-token");

    await expect(saveApiBase("https://second-server.example")).resolves.toMatchObject({ ok: true });

    expect(currentApiBase()).toBe("https://second-server.example");
    await expect(authHeaders()).resolves.toMatchObject({});
    expect(await credentialsForProfile(oldId)).toEqual({ token: "old-host-token", headers: {} });
    expect(pendingSignOutRecords(store)).toEqual([]);
  });

  it("leaves the active profile unchanged when the durable active-ID commit fails", async () => {
    const store = new Map<string, string>();
    await mockProfileStore(store);
    const originalId = activeAccountProfileId();
    if (!originalId) throw new Error("The migrated profile is missing");
    const second = await addAccountProfile("https://second-server.example", "Second", {});
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.active_account_profile") throw new Error("device locked");
      store.set(key, value);
    });

    await expect(activateAccountProfile(second.id)).resolves.toMatchObject({ ok: false });

    expect(activeAccountProfileId()).toBe(originalId);
    expect(currentApiBase()).not.toBe("https://second-server.example");
  });

  it("revokes a removed profile only against that profile's server and headers", async () => {
    const store = new Map<string, string>();
    await mockProfileStore(store);
    const originalId = activeAccountProfileId();
    if (!originalId) throw new Error("The migrated profile is missing");
    const originalUrl = currentApiBase();
    await saveProfileToken(originalId, "removed-token");
    const profileHeaders = { "CF-Access-Client-Id": "removed-access" };
    const removed = await addAccountProfile(
      "https://second-server.example",
      "Second",
      profileHeaders,
    );
    await saveProfileToken(removed.id, "still-saved-token");
    await activateAccountProfile(removed.id);
    await removeSavedAccountProfile(removed.id);

    expect(listAccountProfiles().some(({ id }) => id === removed.id)).toBe(false);
    expect(pendingSignOutRecords(store)).toEqual([
      { apiBase: "https://second-server.example", token: "still-saved-token" },
    ]);
    expect(currentApiBase()).toBe(originalUrl);
    expect(await credentialsForProfile(originalId)).toEqual({
      token: "removed-token",
      headers: {},
    });
  });

  it("does not remove a profile when its sign-out record cannot be persisted", async () => {
    const store = new Map<string, string>();
    await mockProfileStore(store);
    const originalId = activeAccountProfileId();
    if (!originalId) throw new Error("The migrated profile is missing");
    const second = await addAccountProfile("https://second-server.example", "Second", {});
    await saveProfileToken(second.id, "second-token");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.pending_sign_out") throw new Error("device locked");
      store.set(key, value);
    });

    await expect(removeSavedAccountProfile(second.id)).resolves.toBe(false);

    expect(listAccountProfiles().some(({ id }) => id === second.id)).toBe(true);
    expect(activeAccountProfileId()).toBe(originalId);
  });

  it("recovers a deleted-space fallback over a stale saved selection after restart", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
      storage.set(key, value);
    });
    await loadApiBase();

    await expect(selectSpace("space-personal")).resolves.toBe(false);
    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-personal");
    // Stale deleted id is cleared even while the replacement write stays locked.
    expect(storage.has("rakazo.space_id")).toBe(false);
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-personal" }),
    );

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });

  it("clears a deleted selection when every SecureStore write fails after delete", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    await loadApiBase();

    await expect(selectSpace("space-personal")).resolves.toBe(false);
    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-personal");
    expect(storage.has("rakazo.space_id")).toBe(false);
    expect(storage.has("rakazo.space_rollback")).toBe(false);

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();
    // Cleared selection lets startup fall through to the server default.
    expect(restartedApi.selectedSpaceId()).toBeNull();
    await expect(restartedApiServer.selectInitialSpace("space-personal")).resolves.toBe(true);
    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
  });

  it("drops a stale deleted selection when rollback recovery cannot rewrite SPACE_KEY", async () => {
    const storage = new Map<string, string>([
      ["rakazo.space_id", "space-deleted"],
      [
        "rakazo.space_rollback",
        JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-personal" }),
      ],
    ]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();

    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.has("rakazo.space_id")).toBe(false);
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-personal" }),
    );
  });

  it("recovers after restart when SecureStore could neither write nor clear after delete", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    await loadApiBase();

    await expect(selectSpace("space-personal")).resolves.toBe(false);
    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-deleted");

    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBe("space-deleted");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockResolvedValueOnce(jsonResponse({ json: { spaces: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(restartedApi.rpc("spaces/list")).resolves.toEqual({ spaces: [] });
    expect(restartedApi.selectedSpaceId()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1].headers["x-rakazo-space-id"]).toBe("space-deleted");
    expect(fetchMock.mock.calls[1]![1].headers["x-rakazo-space-id"]).toBeUndefined();
  });

  it("does not let a stale rollback override a saved deleted-space fallback", async () => {
    const apiBase = "http://127.0.0.1:3100";
    const storage = new Map<string, string>([
      ["rakazo.space_id", "space-deleted"],
      ["rakazo.space_rollback", JSON.stringify({ apiBase, spaceId: "space-old" })],
    ]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      // clearStoredValue falls back to writing ""; keep that failing for rollback
      // so only an overwrite of the rollback payload can neutralize it.
      if (key === "rakazo.space_rollback" && value === "") throw new Error("device locked");
      storage.set(key, value);
    });
    await loadApiBase();

    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
    // Neutralization overwrote the stale rollback; best-effort clear may leave
    // the matching recovery payload when delete/empty writes stay locked.
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase, spaceId: "space-personal" }),
    );

    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
  });

  it("does not write SPACE_KEY beside a stale rollback when neutralization fails", async () => {
    const apiBase = "http://127.0.0.1:3100";
    const storage = new Map<string, string>([
      ["rakazo.space_id", "space-deleted"],
      ["rakazo.space_rollback", JSON.stringify({ apiBase, spaceId: "space-old" })],
    ]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
      // Block recoverSpaceRollback during loadApiBase, and block SPACE_KEY clears.
      // Writes of the new fallback id would succeed — the bug was doing that write
      // before neutralization, then failing to undo it.
      if (key === "rakazo.space_id" && (value === "" || value === "space-old")) {
        throw new Error("device locked");
      }
      storage.set(key, value);
    });
    await loadApiBase();

    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-personal");
    // Must not leave the new selection durable beside the stale rollback.
    expect(storage.get("rakazo.space_id")).toBe("space-deleted");
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase, spaceId: "space-old" }),
    );

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();
    // Restart may still recover the old rollback target, but must not have
    // replaced a newer SPACE_KEY fallback with it.
    expect(restartedApi.selectedSpaceId()).toBe("space-old");
    expect(storage.get("rakazo.space_id")).toBe("space-old");
  });

  it("heals durable divergence when persisting a new Space fails", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    await loadApiBase();
    await expect(selectSpace("space-support")).resolves.toBe(true);
    // A concurrent recovery persisted the claimed id, then the selection
    // write below fails and rolls the claim back.
    storage.set("rakazo.space_id", "space-new");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-new") {
        throw new Error("device locked");
      }
      storage.set(key, value);
    });

    await expect(selectSpace("space-new")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-support");
    expect(storage.get("rakazo.space_id")).toBe("space-support");
  });

  it("keeps a newer overlapping selection when an older persist fails", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    let rejectA!: Deferred<never>;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        rejectA = deferred<never>();
        await rejectA.promise;
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    rejectA.reject(new Error("device locked"));

    await expect(pendingA).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-b");
    expect(storage.get("rakazo.space_id")).toBe("space-b");
  });

  it("does not commit a selection superseded during rollback cleanup", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-current"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    let releaseOlderCleanup!: Deferred;
    let heldOlderCleanup = false;
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_rollback" && !heldOlderCleanup) {
        heldOlderCleanup = true;
        releaseOlderCleanup = deferred();
        await releaseOlderCleanup.promise;
      }
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();
    expect(selectedSpaceId()).toBe("space-current");

    const previousSeq = spaceSelectionSeq();
    const pendingOlder = selectSpace("space-older");
    expect(spaceSelectionSeq()).toBe(previousSeq + 1);
    expect(selectedSpaceId()).toBe("space-current");
    await vi.waitFor(() => expect(heldOlderCleanup).toBe(true));
    await expect(selectSpace("space-newer")).resolves.toBe(true);
    expect(spaceSelectionSeq()).toBe(previousSeq + 2);
    expect(selectedSpaceId()).toBe("space-newer");
    expect(storage.get("rakazo.space_id")).toBe("space-newer");

    releaseOlderCleanup.resolve();
    await expect(pendingOlder).resolves.toBe(false);
    expect(spaceSelectionSeq()).toBe(previousSeq + 2);
    expect(selectedSpaceId()).toBe("space-newer");
    expect(storage.get("rakazo.space_id")).toBe("space-newer");
  });

  it("converges durable state to the latest overlapping selection", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    let resolveA!: Deferred;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        resolveA = deferred();
        await resolveA.promise;
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    // The older write lands stale after the newer one completed.
    resolveA.resolve();

    await expect(pendingA).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-b");
    expect(storage.get("rakazo.space_id")).toBe("space-b");
    expect(resumeLiveNotifications).toHaveBeenCalledTimes(1);
    expect(resumeLiveNotifications).toHaveBeenLastCalledWith(
      currentApiBase(),
      expect.anything(),
      "space-b",
    );
  });

  it("does not restore the first selection after switching away and back", async () => {
    const storage = new Map<string, string>([["rakazo.session_token", "fake-token"]]);
    let releaseFirstA!: Deferred;
    let firstA = true;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a" && firstA) {
        firstA = false;
        releaseFirstA = deferred();
        await releaseFirstA.promise;
      }
      storage.set(key, value);
    });
    await loadApiBase();
    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(firstA).toBe(false));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    await expect(selectSpace("space-a")).resolves.toBe(true);
    releaseFirstA.resolve();
    await expect(pendingA).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-a");
    expect(storage.get("rakazo.space_id")).toBe("space-a");
    expect(resumeLiveNotifications).toHaveBeenCalledTimes(2);
    expect(resumeLiveNotifications).toHaveBeenLastCalledWith(
      currentApiBase(),
      "fake-token",
      "space-a",
    );
  });

  it("does not restore an obsolete selection after its token read finishes", async () => {
    const storage = new Map<string, string>();
    await mockProfileStore(storage);
    const profileId = activeAccountProfileId();
    if (!profileId) throw new Error("The migrated profile is missing");
    await saveProfileToken(profileId, "fake-token");
    let releaseToken!: Deferred;
    let tokenReadHeld = false;
    let holdTokenRead = false;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === profileCredentialStorageKey(profileId) && holdTokenRead && !tokenReadHeld) {
        tokenReadHeld = true;
        releaseToken = deferred();
        await releaseToken.promise;
      }
      return storage.get(key) ?? null;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    await loadApiBase();
    holdTokenRead = true;

    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(tokenReadHeld).toBe(true));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    releaseToken.resolve();
    await expect(pendingA).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-b");
    expect(storage.get("rakazo.space_id")).toBe("space-b");
    expect(resumeLiveNotifications).toHaveBeenCalledOnce();
    expect(resumeLiveNotifications).toHaveBeenCalledWith(currentApiBase(), "fake-token", "space-b");
  });

  it("does not resume a deleted-space fallback after a newer Space is selected", async () => {
    const storage = new Map<string, string>();
    await mockProfileStore(storage);
    const profileId = activeAccountProfileId();
    if (!profileId) throw new Error("The migrated profile is missing");
    await saveProfileToken(profileId, "fake-token");
    let releaseToken!: Deferred;
    let tokenReadHeld = false;
    let holdTokenRead = false;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === profileCredentialStorageKey(profileId) && holdTokenRead && !tokenReadHeld) {
        tokenReadHeld = true;
        releaseToken = deferred();
        await releaseToken.promise;
      }
      return storage.get(key) ?? null;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    await loadApiBase();
    holdTokenRead = true;
    vi.mocked(resumeLiveNotifications).mockClear();

    const pending = adoptDeletedSpaceFallback("space-fallback");
    await vi.waitFor(() => expect(tokenReadHeld).toBe(true));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    releaseToken.resolve();
    await expect(pending).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-b");
    expect(resumeLiveNotifications).toHaveBeenCalledOnce();
    expect(resumeLiveNotifications).toHaveBeenCalledWith(currentApiBase(), "fake-token", "space-b");
  });

  it("resumes the fallback Space after failed auth recovery invalidates its pending resume", async () => {
    const storage = new Map<string, string>();
    await mockProfileStore(storage);
    const profileId = activeAccountProfileId();
    if (!profileId) throw new Error("The migrated profile is missing");
    await saveProfileToken(profileId, "fake-token");
    let releaseToken!: Deferred;
    let tokenReadHeld = false;
    let holdTokenRead = false;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === profileCredentialStorageKey(profileId) && holdTokenRead && !tokenReadHeld) {
        tokenReadHeld = true;
        releaseToken = deferred();
        await releaseToken.promise;
      }
      return storage.get(key) ?? null;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    await loadApiBase();
    holdTokenRead = true;
    vi.mocked(resumeLiveNotifications).mockClear();

    const pending = adoptDeletedSpaceFallback("space-fallback");
    await vi.waitFor(() => expect(tokenReadHeld).toBe(true));
    let releaseResume!: () => void;
    vi.mocked(resumeLiveNotifications).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseResume = () => resolve(true);
        }),
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
        .mockRejectedValueOnce(new Error("Network unavailable")),
    );
    await expect(rpc("spaces/list")).rejects.toThrow("Network unavailable");
    expect(resumeLiveNotifications).toHaveBeenCalledOnce();
    releaseResume();
    releaseToken.resolve();
    await expect(pending).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-fallback");
    expect(resumeLiveNotifications).toHaveBeenCalledOnce();
    expect(resumeLiveNotifications).toHaveBeenCalledWith(
      currentApiBase(),
      "fake-token",
      "space-fallback",
    );
  });

  it("restores notifications for the previous selection when a newer persist fails", async () => {
    const storage = new Map<string, string>([["rakazo.session_token", "fake-token"]]);
    let releaseA!: Deferred;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        releaseA = deferred();
        await releaseA.promise;
      }
      if (key === "rakazo.space_id" && value === "space-b") throw new Error("device locked");
      storage.set(key, value);
    });
    await loadApiBase();
    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    // Let rollback's recovery write complete without waiting on the older write.
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-b") throw new Error("device locked");
      storage.set(key, value);
    });
    await expect(selectSpace("space-b")).resolves.toBe(false);
    releaseA.resolve();
    await expect(pendingA).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-a");
    expect(storage.get("rakazo.space_id")).toBe("space-a");
    expect(resumeLiveNotifications).toHaveBeenCalledOnce();
    expect(resumeLiveNotifications).toHaveBeenCalledWith(currentApiBase(), "fake-token", "space-a");
  });

  it("keeps a later A claim when an earlier A→B→A persist fails", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    let firstAWriteCount = 0;
    let rejectFirstA!: Deferred<never>;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        firstAWriteCount += 1;
        if (firstAWriteCount === 1) {
          rejectFirstA = deferred<never>();
          await rejectFirstA.promise;
        }
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const pendingFirstA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    await expect(selectSpace("space-a")).resolves.toBe(true);
    expect(storage.get("rakazo.space_id")).toBe("space-a");
    rejectFirstA.reject(new Error("device locked"));

    await expect(pendingFirstA).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-a");
    expect(storage.get("rakazo.space_id")).toBe("space-a");
  });

  it("does not let auth cleanup overwrite a newer selection with a stale snapshot", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    let injected = false;
    let holdCleanupReconcile = false;
    const cleanupWriteHeld = deferred();
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id" && !injected) {
        injected = true;
        // Finish selecting B before cleanup snapshots it for reconcile.
        await expect(selectSpace("space-b")).resolves.toBe(true);
        holdCleanupReconcile = true;
      }
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-b" && holdCleanupReconcile) {
        holdCleanupReconcile = false;
        // Hold only the post-clear reconcile write of the B snapshot.
        await cleanupWriteHeld.promise;
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockResolvedValueOnce(jsonResponse({ json: { spaces: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    const pendingRpc = rpc("spaces/list");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-b"));
    await expect(selectSpace("space-c")).resolves.toBe(true);
    expect(storage.get("rakazo.space_id")).toBe("space-c");
    cleanupWriteHeld.resolve();

    await expect(pendingRpc).resolves.toEqual({ spaces: [] });
    expect(selectedSpaceId()).toBe("space-c");
    expect(storage.get("rakazo.space_id")).toBe("space-c");
  });

  it("does not recover a space on a different endpoint", async () => {
    const storage = new Map([
      ["rakazo.api_base", "https://second-server.example"],
      [
        "rakazo.space_rollback",
        JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-support" }),
      ],
    ]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");

    await expect(restartedApiServer.loadApiBase()).resolves.toBe("https://second-server.example");
    expect(restartedApi.selectedSpaceId()).toBeNull();
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });

  it("removes a malformed space rollback record", async () => {
    const storage = new Map([["rakazo.space_rollback", "null"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");

    await restartedApiServer.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBeNull();
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });
});
