import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

class AppStoreMetadataError extends Error {}

export function appStoreFailureMessage(error: unknown) {
  return error instanceof AppStoreMetadataError
    ? error.message
    : "App Store name update failed. Check the release credentials and retry.";
}

const PRIVACY_POLICY_URL = "https://saddletree.ai/privacy";

/** Update the existing listing's brand; never create an app or submit it for public review. */
export async function updateAppStoreName({
  appId,
  name,
  token,
  fetchImpl = fetch,
}: {
  appId: string;
  name: string;
  token: string;
  fetchImpl?: typeof fetch;
}) {
  async function request<T>(path: string, body?: unknown) {
    const response = await fetchImpl(`https://api.appstoreconnect.apple.com/v1/${path}`, {
      method: body ? "PATCH" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch((error: unknown) => {
        if (error instanceof SyntaxError) return null;
        throw error;
      });
      const duplicate =
        body &&
        typeof body === "object" &&
        "errors" in body &&
        Array.isArray(body.errors) &&
        body.errors.some(
          (error: unknown) =>
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE.DIFFERENT_ACCOUNT",
        );
      throw new AppStoreMetadataError(
        duplicate
          ? "The requested App Store name belongs to another account. Choose a different listing name."
          : `App Store metadata request failed (${response.status}).`,
      );
    }
    return response.json() as Promise<T>;
  }
  const infos = await request<{ data: { id: string; attributes: { appStoreState: string } }[] }>(
    `apps/${encodeURIComponent(appId)}/appInfos?limit=200`,
  );
  let changed = 0;
  let current = 0;
  const editable = new Set([
    "PREPARE_FOR_SUBMISSION",
    "REJECTED",
    "METADATA_REJECTED",
    "DEVELOPER_REJECTED",
  ]);
  for (const info of infos.data) {
    const localizations = await request<{
      data: { id: string; attributes: { name: string; privacyPolicyUrl?: string | null } }[];
    }>(`appInfos/${encodeURIComponent(info.id)}/appInfoLocalizations?limit=200`);
    for (const locale of localizations.data) {
      if (
        locale.attributes.name === name &&
        locale.attributes.privacyPolicyUrl === PRIVACY_POLICY_URL
      ) {
        current++;
        continue;
      }
      if (!editable.has(info.attributes.appStoreState)) continue;
      await request(`appInfoLocalizations/${encodeURIComponent(locale.id)}`, {
        data: {
          type: "appInfoLocalizations",
          id: locale.id,
          attributes: { name, privacyPolicyUrl: PRIVACY_POLICY_URL },
        },
      });
      changed++;
    }
  }
  if (!changed && !current)
    throw new AppStoreMetadataError(
      "The app metadata is not editable in its current App Store state.",
    );
  return { changed, current };
}

async function main() {
  const config = JSON.parse(process.env.MOBILE_DISTRIBUTION_CONFIG ?? "{}");
  const { expo } = JSON.parse(await readFile(new URL("../app.json", import.meta.url), "utf8"));
  const issuer = process.env.APPLE_API_ISSUER;
  const kid = process.env.APPLE_API_KEY_ID;
  const pem = process.env.APPLE_API_KEY_P8;
  if (!issuer || !kid || !pem || !/^\d+$/.test(config.appStoreConnectAppId ?? ""))
    throw new AppStoreMetadataError("App Store release credentials are incomplete.");
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = `${encode({ alg: "ES256", kid, typ: "JWT" })}.${encode({ iss: issuer, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })}`;
  const key = createPrivateKey(
    pem.includes("BEGIN PRIVATE KEY") ? pem : Buffer.from(pem, "base64"),
  );
  const signature = sign("sha256", Buffer.from(payload), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  const result = await updateAppStoreName({
    appId: config.appStoreConnectAppId,
    name: expo.name,
    token: `${payload}.${signature}`,
  });
  console.log(
    `App Store name: ${result.changed} localization(s) updated; ${result.current} already current.`,
  );
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(appStoreFailureMessage(error));
    process.exitCode = 1;
  });
}
