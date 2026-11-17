import { deferred } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => true),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-constants", () => ({ default: { easConfig: { projectId: "fake-project" } } }));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: vi.fn(() => null) }));

// Expo runs every module's async functions on one serial native queue, so a call
// that waits there holds up SecureStore too.
const native = vi.hoisted(() => {
  let queue: Promise<unknown> = Promise.resolve();
  const run = <T>(work: () => T | Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };
  const store = new Map<string, string>();
  return {
    run,
    store,
    reset() {
      queue = Promise.resolve();
      store.clear();
    },
  };
});

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn((key: string) => native.run(() => native.store.get(key) ?? null)),
  setItemAsync: vi.fn((key: string, value: string) =>
    native.run(() => void native.store.set(key, value)),
  ),
  deleteItemAsync: vi.fn((key: string) => native.run(() => void native.store.delete(key))),
}));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(async () => ({ data: "ExponentPushToken[fake]" })),
}));

import { requireOptionalNativeModule } from "expo-modules-core";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { addAccountProfile, loadAccountProfiles, saveProfileToken } from "./account-profiles";
import { rpc } from "./api";
import { signOut } from "./api-auth";
import { selectInitialSpace } from "./api-server";
import { resumeLiveNotifications } from "./live-notifications.js";
import { registerPushToken } from "./push";
import { restoreSessionToken } from "./session";

const settled = <T>(promise: Promise<T>) =>
  Promise.race([promise, new Promise((done) => setTimeout(done, 100, "still waiting"))]);

const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
  const json = url.endsWith("/rpc/me")
    ? { userId: "user-1", spaceId: "space-1" }
    : url.endsWith("/rpc/spaces/list")
      ? { current: { id: "space-1", bots: [{ id: "bot-1" }] }, spaces: [] }
      : {};
  return new Response(JSON.stringify({ json }), { status: 200 });
});

let permission: ReturnType<typeof deferred<{ granted: boolean }>>;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  native.reset();
  vi.mocked(requireOptionalNativeModule).mockReturnValue(null);
  vi.stubGlobal("fetch", fetch);
  permission = deferred();
  // iOS answers both from the system's notification settings, which can take minutes
  // after a restart. Reading them waits on the native queue; the request does not.
  vi.mocked(Notifications.getPermissionsAsync).mockImplementation(() =>
    native.run(() => new Promise(() => {})),
  );
  vi.mocked(Notifications.requestPermissionsAsync).mockImplementation(
    () => native.run(() => undefined).then(() => permission.promise) as never,
  );
  await loadAccountProfiles({
    serverUrl: "http://127.0.0.1:3100",
    token: "",
    headers: {},
  });
  await restoreSessionToken("fake-session");
});

afterEach(() => {
  Platform.OS = "ios";
  vi.unstubAllGlobals();
});

describe("push registration on iOS", () => {
  it("loads the inbox while notification settings have not answered", async () => {
    void registerPushToken();

    // The inbox's first load: the space list and account, then the default space.
    const loaded = Promise.all([rpc("spaces/list"), rpc("me")]).then(async ([, me]) =>
      selectInitialSpace(me.spaceId),
    );

    await expect(settled(loaded)).resolves.toBe(true);
  });

  it("registers the token once permission is granted", async () => {
    void registerPushToken();
    await settled(Promise.resolve());
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringMatching(/notifications\/registerPush$/),
      expect.anything(),
    );

    permission.resolve({ granted: true });

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringMatching(/notifications\/registerPush$/),
        expect.objectContaining({
          body: expect.stringContaining('"token":"ExponentPushToken[fake]"'),
        }),
      ),
    );
  });
});

describe("push registration on Android", () => {
  it("does not ask again once notifications are allowed", async () => {
    Platform.OS = "android";
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);

    await registerPushToken();

    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/notifications\/registerPush$/),
      expect.anything(),
    );
  });
});

it("syncs the native session before the server can push", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  const resumed = deferred<boolean>();
  vi.mocked(resumeLiveNotifications).mockReturnValueOnce(resumed.promise);

  const registration = registerPushToken();
  try {
    await vi.waitFor(() =>
      expect(resumeLiveNotifications).toHaveBeenCalledExactlyOnceWith(
        "http://127.0.0.1:3100",
        "fake-session",
        expect.any(String),
      ),
    );
    await expect(settled(registration)).resolves.toBe("still waiting");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    resumed.resolve(true);
    await registration;
  }
  expect(fetch).toHaveBeenCalledWith(
    expect.stringMatching(/notifications\/registerPush$/),
    expect.anything(),
  );
});

it("does not register after sign-out while notification permission is pending", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: false } as never);
  const registration = registerPushToken();
  await signOut();
  permission.resolve({ granted: true });
  await registration;

  expect(resumeLiveNotifications).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalledWith(
    expect.stringMatching(/notifications\/registerPush$/),
    expect.anything(),
  );
});

it("does not register the push token when the native session sync fails", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  vi.mocked(resumeLiveNotifications).mockRejectedValueOnce(new Error("native sync failed"));

  await registerPushToken();

  // Registering now would have Android drop every push as signed-out; the next
  // registration attempt retries the session sync first.
  expect(fetch).not.toHaveBeenCalledWith(
    expect.stringMatching(/notifications\/registerPush$/),
    expect.anything(),
  );
});

it("does not register push while a sign-in has not saved its token yet", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  await signOut();

  await registerPushToken();

  expect(resumeLiveNotifications).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalledWith(
    expect.stringMatching(/notifications\/registerPush$/),
    expect.anything(),
  );
});

it("registers native sender delivery only when the installed Android module supports it", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  vi.mocked(requireOptionalNativeModule).mockReturnValue({ supportsSenderAvatars: true });
  await registerPushToken();
  const call = fetch.mock.calls.find(([url]) => url.endsWith("/rpc/notifications/registerPush"));
  const options = (call as unknown as [string, RequestInit])[1];
  expect(JSON.parse(String(options.body)).json).toMatchObject({
    presentation: "android_sender",
    clientProfileId: expect.any(String),
    serverOrigin: "http://127.0.0.1:3100",
  });
});

it("registers plain delivery when the native module does not keep the session", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  vi.mocked(requireOptionalNativeModule).mockReturnValue({ supportsSenderAvatars: true });
  // A public http server: native notifications skip it and store no session.
  vi.mocked(resumeLiveNotifications).mockResolvedValueOnce(false);
  await registerPushToken();
  const call = fetch.mock.calls.find(([url]) => url.endsWith("/rpc/notifications/registerPush"));
  const options = (call as unknown as [string, RequestInit])[1];
  // Sender delivery would drop every push as signed out; plain pushes are still shown.
  expect(JSON.parse(String(options.body)).json).not.toHaveProperty("presentation");
});

it("registers inactive profiles with their own host and credentials", async () => {
  Platform.OS = "android";
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  const activeId = (
    await loadAccountProfiles({
      serverUrl: "http://127.0.0.1:3100",
      token: "fake-session",
      headers: { "x-instance-key": "active-key" },
    })
  ).id;
  const inactive = await addAccountProfile("https://other.example", "Other", {
    "x-instance-key": "inactive-key",
  });
  await saveProfileToken(inactive.id, "other-session");

  await registerPushToken();

  const registrations = fetch.mock.calls
    .filter(([url]) => url.endsWith("/rpc/notifications/registerPush"))
    .map(([url, init]) => ({ url, body: JSON.parse(String(init?.body)).json }));
  expect(registrations).toHaveLength(2);
  expect(registrations.map(({ url }) => url)).toEqual([
    "http://127.0.0.1:3100/rpc/notifications/registerPush",
    "https://other.example/rpc/notifications/registerPush",
  ]);
  expect(registrations.map(({ body }) => body)).toMatchObject([
    { clientProfileId: activeId, serverOrigin: "http://127.0.0.1:3100" },
    { clientProfileId: inactive.id, serverOrigin: "https://other.example" },
  ]);
  expect(
    fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization")),
  ).toContain("Bearer other-session");
  expect(resumeLiveNotifications).toHaveBeenCalledExactlyOnceWith(
    "http://127.0.0.1:3100",
    "fake-session",
    expect.any(String),
  );
});
