import { useLingui } from "@lingui/react/macro";
import { Stack, useRouter } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { Alert, Pressable, ScrollView, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSymbol } from "../components/native-symbol";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import {
  activeAccountProfileId,
  listAccountProfiles,
  subscribeAccountProfiles,
} from "../lib/account-profiles";
import { activateAccountProfile, removeSavedAccountProfile } from "../lib/api-server";
import { useMobileTokens } from "../lib/native";
import { loadSessionToken } from "../lib/session";
import { useSideInsets } from "../lib/side-insets";

export default function AccountsScreen() {
  const { t } = useLingui();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const tokens = useMobileTokens();
  const profiles = useSyncExternalStore(
    subscribeAccountProfiles,
    listAccountProfiles,
    listAccountProfiles,
  );
  const selected = useSyncExternalStore(
    subscribeAccountProfiles,
    activeAccountProfileId,
    activeAccountProfileId,
  );
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function finishSwitch() {
    const token = await loadSessionToken();
    router.dismissAll();
    router.replace(token ? "/" : "/sign-in");
  }

  async function select(profileId: string) {
    if (pendingId || profileId === selected) return;
    setPendingId(profileId);
    try {
      const result = await activateAccountProfile(profileId);
      if (!result.ok) {
        Alert.alert(t`Could not switch account`, result.error);
        return;
      }
      await finishSwitch();
    } finally {
      setPendingId(null);
    }
  }

  function remove(profileId: string, label: string) {
    Alert.alert(t`Remove account?`, label, [
      { text: t`Cancel`, style: "cancel" },
      {
        text: t`Remove`,
        style: "destructive",
        onPress: () => {
          void (async () => {
            setPendingId(profileId);
            try {
              if (!(await removeSavedAccountProfile(profileId))) {
                Alert.alert(t`Could not remove account`, t`Try again.`);
                return;
              }
              if (profileId === selected) await finishSwitch();
            } finally {
              setPendingId(null);
            }
          })();
        },
      },
    ]);
  }

  return (
    <SafeAreaView edges={["bottom"]} style={{ flex: 1, backgroundColor: tokens.background }}>
      <Stack.Screen options={{ title: t`Accounts` }} />
      <ScrollView
        style={sideInsets}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 24,
          paddingTop: 12,
          paddingBottom: 24,
          gap: 16,
        }}
      >
        <SettingsGroup>
          {profiles.map((profile) => {
            const host = (() => {
              try {
                return new URL(profile.serverUrl).host;
              } catch {
                return profile.serverUrl;
              }
            })();
            const active = profile.id === selected;
            return (
              <SettingsRow
                key={profile.id}
                accessibilityRole="button"
                accessibilityState={{ selected: active, disabled: Boolean(pendingId) }}
                chevron={active ? undefined : "right"}
                disabled={Boolean(pendingId)}
                detail={host}
                leading={
                  active ? (
                    <NativeSymbol
                      ios="checkmark.circle.fill"
                      android="checkmark-circle"
                      color={tokens.primary}
                    />
                  ) : undefined
                }
                onLongPress={() => profiles.length > 1 && remove(profile.id, profile.label)}
                onPress={() => void select(profile.id)}
                title={profile.label}
                trailing={
                  profiles.length > 1 ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t`Remove account`}
                      hitSlop={8}
                      onPress={(event) => {
                        event.stopPropagation();
                        remove(profile.id, profile.label);
                      }}
                      style={{ padding: 8 }}
                    >
                      <Text style={{ color: tokens.destructive }}>{t`Remove`}</Text>
                    </Pressable>
                  ) : undefined
                }
              />
            );
          })}
        </SettingsGroup>
        <NativeActionButton
          label={t`Add account`}
          onPress={() => router.push({ pathname: "/server", params: { addProfile: "1" } })}
          icon={{ ios: "plus", android: "add" }}
          prominence="plain"
          fill
        />
      </ScrollView>
    </SafeAreaView>
  );
}
