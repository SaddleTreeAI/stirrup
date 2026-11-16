import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

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
    if (!response.ok) throw new Error(`App Store metadata request failed (${response.status}).`);
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
    throw new Error("The app metadata is not editable in its current App Store state.");
  return { changed, current };
}

async function main() {
  const config = JSON.parse(process.env.MOBILE_DISTRIBUTION_CONFIG ?? "{}");
  const { expo } = JSON.parse(await readFile(new URL("../app.json", import.meta.url), "utf8"));
  const issuer = process.env.APPLE_API_ISSUER;
  const kid = process.env.APPLE_API_KEY_ID;
  const pem = process.env.APPLE_API_KEY_P8;
  if (!issuer || !kid || !pem || !/^\d+$/.test(config.appStoreConnectAppId ?? ""))
    throw new Error("App Store release credentials are incomplete.");
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
  await main().catch(() => {
    console.error(
      "App Store name update failed. Check the app's editable metadata and release credentials.",
    );
    process.exitCode = 1;
  });
}
