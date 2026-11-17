import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useSyncExternalStore } from "react";
import { activeAccountProfileId, listAccountProfiles } from "./account-profiles";
import { activateAccountProfile } from "./api-server";
import {
  notificationAccountBinding,
  notificationResponseRoute,
  threadRouteId,
} from "./notification-open";
import { currentSessionGeneration, loadSessionToken, subscribeSessionGeneration } from "./session";
import { closeSettingsSheet } from "./settings-sheet";

const openedResponses = new Set<string>();
const waitingForProfileSignIn = new Map<string, number>();

/** Expo's request identifier is the scheduled request. These pushes use the
 * thread id for that value, so a later delivery of the same thread shares it.
 * The payload delivery id is the occurrence. */
function occurrenceKey(response: Notifications.NotificationResponse): string | null {
  const identifier = response.notification.request.identifier;
  if (!identifier) return null;
  const data = response.notification.request.content.data;
  const deliveryId =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).deliveryId
      : undefined;
  const occurrence = typeof deliveryId === "string" ? deliveryId.trim() : "";
  return occurrence ? `${identifier}\0${occurrence}` : identifier;
}

function clearNotificationResponseIfCurrent(response: Notifications.NotificationResponse): void {
  const last = Notifications.getLastNotificationResponse();
  const key = occurrenceKey(response);
  if (last && key && key === occurrenceKey(last)) Notifications.clearLastNotificationResponse();
}

export async function openNotificationResponse(
  response: Notifications.NotificationResponse | null | undefined,
): Promise<boolean> {
  if (!response) return false;
  const key = occurrenceKey(response);
  if (!key) return false;
  const waitingGeneration = waitingForProfileSignIn.get(key);
  if (waitingGeneration !== undefined) {
    if (currentSessionGeneration() <= waitingGeneration) return false;
    waitingForProfileSignIn.delete(key);
    openedResponses.delete(key);
  }
  if (openedResponses.has(key)) return false;
  const target = notificationResponseRoute(response, Notifications.DEFAULT_ACTION_IDENTIFIER);
  if (!target) return false;
  // Claim before the session read so a cold-start hook and the tap listener
  // cannot both open the same response.
  openedResponses.add(key);
  try {
    const data = response.notification.request.content.data;
    const binding = notificationAccountBinding(data);
    const hasBindingField =
      data !== null &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      ("clientProfileId" in data ||
        "rakazo.clientProfileId" in data ||
        "serverOrigin" in data ||
        "rakazo.serverOrigin" in data);
    if (hasBindingField && !binding) {
      clearNotificationResponseIfCurrent(response);
      openedResponses.delete(key);
      return false;
    }
    let switchedProfile = false;
    if (binding) {
      const profile = listAccountProfiles().find((item) => item.id === binding.clientProfileId);
      const origin = profile ? new URL(profile.serverUrl).origin : null;
      if (!profile || origin !== binding.serverOrigin) {
        clearNotificationResponseIfCurrent(response);
        openedResponses.delete(key);
        return false;
      }
      if (profile.id !== activeAccountProfileId()) {
        const switched = await activateAccountProfile(profile.id);
        if (!switched.ok) {
          clearNotificationResponseIfCurrent(response);
          openedResponses.delete(key);
          return false;
        }
        switchedProfile = true;
      }
    }
    if (!(await loadSessionToken())) {
      if (binding) {
        // Keep this tap pending until the right account signs in; the token for another profile
        // must never open or authorize this route.
        waitingForProfileSignIn.set(key, currentSessionGeneration());
        router.dismissAll();
        router.replace("/sign-in");
        return false;
      }
      // Expo keeps this tap as the last response. Leaving it there would open
      // the thread on a later cold start, after sign-in, with no new tap.
      // A newer delivery can become last while this session read is in flight.
      clearNotificationResponseIfCurrent(response);
      openedResponses.delete(key);
      return false;
    }
    closeSettingsSheet();
    if (switchedProfile) {
      router.dismissAll();
      router.replace("/");
    }
    router.push(target, { dangerouslySingular: threadRouteId });
    clearNotificationResponseIfCurrent(response);
    return true;
  } catch {
    openedResponses.delete(key);
    return false;
  }
}

/** Opens the thread for a notification tap, including the tap that cold-started the app. */
export function useNotificationResponses(enabled: boolean): void {
  const lastResponse = Notifications.useLastNotificationResponse();
  const sessionGeneration = useSyncExternalStore(
    subscribeSessionGeneration,
    currentSessionGeneration,
    currentSessionGeneration,
  );

  useEffect(() => {
    if (!enabled) return;
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      void openNotificationResponse(response);
    });
    return () => subscription.remove();
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !lastResponse) return;
    void openNotificationResponse(lastResponse);
  }, [enabled, lastResponse, sessionGeneration]);
}
