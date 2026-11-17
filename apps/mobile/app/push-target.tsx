import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { ActivityIndicator, Alert, View } from "react-native";
import { activeAccountProfileId, listAccountProfiles } from "../lib/account-profiles";
import { activateAccountProfile } from "../lib/api-server";
import { notificationAccountBinding, notificationOpenTarget } from "../lib/notification-open";
import { loadSessionToken } from "../lib/session";

/** Native Android sender-push links must bind to a locally saved account before opening a chat. */
export default function PushTargetRoute() {
  const params = useLocalSearchParams<Record<string, string | string[]>>();
  const router = useRouter();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    void (async () => {
      const binding = notificationAccountBinding(params);
      const target = notificationOpenTarget(params);
      const profile =
        binding && listAccountProfiles().find((item) => item.id === binding.clientProfileId);
      if (
        !binding ||
        !target ||
        !profile ||
        new URL(profile.serverUrl).origin !== binding.serverOrigin
      ) {
        Alert.alert(
          "Notification unavailable",
          "This notification is not linked to a saved account.",
        );
        router.replace("/");
        return;
      }

      if (profile.id !== activeAccountProfileId()) {
        const activated = await activateAccountProfile(profile.id);
        if (!activated.ok) {
          Alert.alert("Could not switch account", activated.error);
          router.replace("/");
          return;
        }
      }
      if (!(await loadSessionToken())) {
        router.replace("/sign-in");
        return;
      }
      router.replace(target);
    })().catch(() => router.replace("/"));
  }, [params, router]);

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator />
    </View>
  );
}
