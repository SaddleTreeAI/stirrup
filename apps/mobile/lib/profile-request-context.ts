import { t } from "@lingui/core/macro";
import { credentialsForProfile, listAccountProfiles } from "./account-profiles";
import { currentSessionGeneration } from "./session";

export type ApiRequestContext = {
  profileId?: string;
  sessionGeneration?: number;
  apiBase: string;
  headers: Record<string, string>;
};

/** Pins an authenticated request to a saved profile without borrowing the active session. */
export async function captureSavedProfileRequestContext(
  profileId: string,
  spaceId: string | null,
  clientHeaders: Record<string, string>,
): Promise<ApiRequestContext> {
  const generation = currentSessionGeneration();
  const profile = listAccountProfiles().find((item) => item.id === profileId);
  if (!profile) throw new Error(t`That account is no longer available.`);
  const credentials = await credentialsForProfile(profileId);
  if (!credentials.token) throw new Error(t`Sign in to this account first.`);
  if (generation !== currentSessionGeneration())
    throw new Error(t`The account changed while starting the request`);
  return {
    profileId,
    apiBase: profile.serverUrl,
    sessionGeneration: generation,
    headers: {
      ...clientHeaders,
      authorization: `Bearer ${credentials.token}`,
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      ...credentials.headers,
    },
  };
}
