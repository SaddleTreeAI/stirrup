vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeAccountProfileId, profileCredentialStorageKey } from "./account-profiles";
import { authHeaders, currentApiBase } from "./api.js";
import { passwordResetCapabilities } from "./api-auth.js";
import { loadApiBase, resetApiBase, saveApiBase } from "./api-server.js";
import { defaultApiBase, probeApiBase } from "./endpoint.js";
import { fetchServer, serverHeaders, serverHeadersForUrl } from "./server-headers.js";

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

const SERVER = "https://rakazo.example.test";
const ACCESS = { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "secret" };

let store: Map<string, string>;

beforeEach(async () => {
  store = new Map();
  vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => store.get(key) ?? null);
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
    store.set(key, value);
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
    store.delete(key);
  });
  await loadApiBase();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await resetApiBase();
});

describe("server request headers", () => {
  it("preserves fetch options by default and prevents credentialed redirects only when configured", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"),
    );
    const init = { method: "POST", headers: { origin: "rakazo://" } };
    await fetchServer(SERVER, init, SERVER, fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]).toBe(init);
    await saveApiBase(SERVER, ACCESS);
    await fetchServer(`${SERVER}/rpc/me`, { ...init, redirect: "follow" }, SERVER, fetchImpl);
    expect(fetchImpl.mock.calls[1]?.[1]?.redirect).toBe("error");
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get("cf-access-client-secret")).toBe(
      "secret",
    );
    await fetchServer("https://other.example/rpc", init, SERVER, fetchImpl);
    expect(fetchImpl.mock.calls[2]?.[1]).toBe(init);
    expect(serverHeadersForUrl("http://rakazo.example.test/rpc", SERVER)).toEqual({});
    expect(serverHeadersForUrl(`${SERVER}:8443/rpc`, SERVER)).toEqual({});
  });

  it("sends saved headers only to the server they were saved for", async () => {
    await expect(saveApiBase(SERVER, ACCESS)).resolves.toEqual({ ok: true, url: SERVER });

    expect(serverHeaders(currentApiBase())).toEqual(ACCESS);
    expect(await authHeaders(null)).toHaveProperty("CF-Access-Client-Secret", "secret");
    expect(serverHeadersForUrl(`${SERVER}/rpc/me`, currentApiBase())).toEqual(ACCESS);
    expect(serverHeadersForUrl("https://rakazo.example.test.evil/rpc", SERVER)).toEqual({});
    expect(serverHeadersForUrl("https://other.example.test/rpc", SERVER)).toEqual({});
  });

  it("adds them to unauthenticated auth requests without replacing the caller's own", async () => {
    await saveApiBase(SERVER, ACCESS);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ passwordReset: false, sso: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await passwordResetCapabilities().catch(() => undefined);

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("cf-access-client-id")).toBe("id.access");
    expect(headers.get("origin")).toBe("rakazo://");
  });

  it("restores saved headers on launch and drops them for another server", async () => {
    await saveApiBase(SERVER, ACCESS);
    await loadApiBase();
    expect(serverHeaders(currentApiBase())).toEqual(ACCESS);

    await saveApiBase("https://second.example.test");
    expect(await authHeaders(null)).not.toHaveProperty("CF-Access-Client-Id");
    expect(JSON.parse(store.get("rakazo.server_headers") ?? "null").headers).toEqual({});
  });

  it("keeps profile headers when secure storage refuses an update", async () => {
    await saveApiBase(SERVER, ACCESS);
    const profileId = activeAccountProfileId();
    if (!profileId) throw new Error("The active profile is missing");
    const key = profileCredentialStorageKey(profileId);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (writeKey, value) => {
      if (writeKey === key) throw new Error("Storage unavailable");
      store.set(writeKey, value);
    });
    await expect(saveApiBase(SERVER, { "X-Access": "replacement" })).resolves.toMatchObject({
      ok: false,
    });
    expect(serverHeaders(SERVER)).toEqual(ACCESS);
  });

  it("resets to a saved default profile without deleting the other profile", async () => {
    await saveApiBase(SERVER, ACCESS);
    const profileId = activeAccountProfileId();
    await expect(resetApiBase()).resolves.toMatchObject({ ok: true, url: defaultApiBase() });
    expect(currentApiBase()).toBe(defaultApiBase());
    expect(activeAccountProfileId()).not.toBe(profileId);
  });

  it("ignores a damaged saved value", async () => {
    store.set("rakazo.api_base", SERVER);
    store.set(
      "rakazo.server_headers",
      JSON.stringify({ apiBase: SERVER, headers: { origin: "x" } }),
    );
    await loadApiBase();
    expect(serverHeaders(SERVER)).toEqual({});
  });

  it("checks a new server with the headers it will use", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ json: { ok: true } })),
    );
    await probeApiBase(SERVER, fetchImpl as typeof fetch, ACCESS);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      ...ACCESS,
      origin: "rakazo://",
    });
  });
});
