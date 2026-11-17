import { newClientId } from "@rakazo/core";
import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo-modules-core";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import {
  activeAccountProfileId,
  credentialsForProfile,
  listAccountProfiles,
  profileSpaceStorageKey,
} from "./account-profiles";
import { captureProfileRequestContext, currentApiBase, rpc, selectedSpaceId } from "./api";
import { resumeLiveNotifications } from "./live-notifications";
import { currentSessionGeneration } from "./session";

async function notificationsAllowed() {
  // On iOS getPermissionsAsync holds Expo's shared native queue until the system answers,
  // which can take minutes after a restart, and SecureStore waits behind it. The request
  // does not hold the queue and only prompts while the user hasn't chosen yet.
  if (Platform.OS === "ios") return (await Notifications.requestPermissionsAsync()).granted;
  const existing = await Notifications.getPermissionsAsync();
  return existing.granted || (await Notifications.requestPermissionsAsync()).granted;
}

export async function registerPushToken() {
  if (!(await notificationsAllowed())) return;
  try {
    const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    if (!token) return;
    const generation = currentSessionGeneration();
    const activeId = activeAccountProfileId();
    const profiles = listAccountProfiles();
    if (!activeId || !profiles.length) return;
    const orderedProfiles = [
      ...profiles.filter((profile) => profile.id === activeId),
      ...profiles.filter((profile) => profile.id !== activeId),
    ];
    for (const profile of orderedProfiles) {
      const credentials = await credentialsForProfile(profile.id);
      // Sign-in of an added profile may still be saving its token. It will retry
      // registration after the session lands, without borrowing another token.
      if (!credentials.token) continue;
      if (generation !== currentSessionGeneration()) return;
      let profileSpace = "";
      try {
        profileSpace = (await SecureStore.getItemAsync(profileSpaceStorageKey(profile.id))) ?? "";
      } catch {
        // Register account-level pushes if a saved Space preference is temporarily unreadable.
      }
      const isActive = profile.id === activeId && currentApiBase() === profile.serverUrl;
      const requestContext = await captureProfileRequestContext(
        profile.id,
        isActive ? selectedSpaceId() : profileSpace,
      );
      let nativeSession = false;
      if (isActive) {
        // The server may push as soon as registration lands. Resume the active
        // native session first so Android's signed-out drop rule sees this account.
        // Inactive profiles are registered without replacing that native session.
        try {
          nativeSession = await resumeLiveNotifications(
            profile.serverUrl,
            credentials.token,
            selectedSpaceId() ?? "",
          );
        } catch {
          continue;
        }
      }
      const payload = {
        token,
        clientProfileId: profile.id,
        serverOrigin: new URL(profile.serverUrl).origin,
        ...(Platform.OS === "android" &&
        nativeSession &&
        requireOptionalNativeModule<{ supportsSenderAvatars?: boolean }>("RakazoNotifications")
          ?.supportsSenderAvatars
          ? { presentation: "android_sender" as const }
          : {}),
      };
      try {
        await rpc("notifications/registerPush", payload, { requestContext });
        if (isActive) await registerCallPushToken({ expoToken: token });
      } catch {
        // A server may be offline or this profile may have expired; keep other
        // saved profiles registered and retry this one on the next sync.
      }
    }
  } catch {
    // Expo Go without an EAS project id and Android builds without a Firebase config
    // cannot mint an Expo push token.
  }
}

export async function unregisterPushToken() {
  await rpc("notifications/unregisterPush").catch(() => undefined);
}

let callTokens: { expoToken?: string; voipToken?: string } = {};
let tokenGeneration = -1;
let registeredKey: string | undefined;
let deviceIdPromise: Promise<string> | undefined;
async function installationId() {
  deviceIdPromise ??= (async () => {
    const stored = await SecureStore.getItemAsync("rakazo.call-device");
    if (stored) return stored;
    const id = newClientId();
    await SecureStore.setItemAsync("rakazo.call-device", id);
    return id;
  })();
  const pending = deviceIdPromise;
  try {
    return await pending;
  } catch (error) {
    if (deviceIdPromise === pending) deviceIdPromise = undefined;
    throw error;
  }
}
/** Builds without native call handling keep the account's ordinary push for incoming calls. */
const nativeCalls = Boolean(
  requireOptionalNativeModule<{ incomingState?: unknown }>("RakazoNotifications")?.incomingState,
);

export async function registerCallPushToken(tokens: { expoToken?: string; voipToken?: string }) {
  if (!nativeCalls) return;
  const generation = currentSessionGeneration();
  if (generation !== tokenGeneration) {
    callTokens = {};
    registeredKey = undefined;
    tokenGeneration = generation;
  }
  const registration = { ...callTokens, ...tokens };
  const key = JSON.stringify(registration);
  if (key === registeredKey) return;
  callTokens = registration;
  const deviceId = await installationId();
  if (generation !== currentSessionGeneration()) return;
  if (Platform.OS !== "ios" && Platform.OS !== "android") return;
  await rpc("notifications/registerCallPush", { deviceId, platform: Platform.OS, ...registration });
  if (generation === currentSessionGeneration()) registeredKey = key;
}
