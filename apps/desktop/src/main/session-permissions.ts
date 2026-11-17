import { secureHttpOrigin as httpOrigin } from "@rakazo/contracts/network-host";
import type { Session, WebContents } from "electron";

const notificationTargets = new WeakMap<Session, Map<WebContents, string>>();

type AppPermissionTarget = {
  webContents: WebContents;
  url: string;
};

/** Install before loading any content, including setup, storage probes and OAuth popups. */
export function installSessionPermissions(
  targetSession: Session,
  getApp: () => AppPermissionTarget | null,
) {
  function currentApp() {
    const app = getApp();
    if (!app || app.webContents.isDestroyed() || app.webContents.session !== targetSession) {
      return null;
    }
    const origin = httpOrigin(app.url);
    if (origin === null || httpOrigin(app.webContents.getURL()) !== origin) return null;
    return { ...app, origin };
  }

  targetSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const app = currentApp();
    const notificationOrigin = notificationTargets.get(targetSession)?.get(contents);
    if (
      !app &&
      permission === "notifications" &&
      notificationOrigin !== undefined &&
      details.isMainFrame &&
      httpOrigin(details.requestingUrl) === notificationOrigin
    ) {
      callback(true);
      return;
    }
    if (
      !app ||
      contents !== app.webContents ||
      !details.isMainFrame ||
      httpOrigin(details.requestingUrl) !== app.origin
    ) {
      callback(false);
      return;
    }

    if (permission === "media") {
      // Dictation needs only the microphone. OS consent still applies after this grant.
      callback(
        "securityOrigin" in details &&
          httpOrigin(details.securityOrigin) === app.origin &&
          "mediaTypes" in details &&
          (details.mediaTypes?.length ?? 0) > 0 &&
          details.mediaTypes?.every((type) => type === "audio") === true,
      );
      return;
    }
    callback(permission === "notifications" || permission === "clipboard-sanitized-write");
  });

  targetSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const app = currentApp();
    if (!app) {
      const origin = httpOrigin(requestingOrigin);
      const permittedOrigin = contents
        ? notificationTargets.get(targetSession)?.get(contents)
        : null;
      if (
        permission !== "notifications" ||
        origin === null ||
        (contents !== null && permittedOrigin !== origin) ||
        (contents === null &&
          ![...(notificationTargets.get(targetSession)?.values() ?? [])].includes(origin))
      )
        return false;
      return (
        (details.embeddingOrigin === undefined || httpOrigin(details.embeddingOrigin) === origin) &&
        (details.securityOrigin === undefined || httpOrigin(details.securityOrigin) === origin) &&
        (contents === null ||
          (!contents.isDestroyed() &&
            contents.mainFrame !== null &&
            httpOrigin(contents.getURL()) === origin &&
            httpOrigin(details.requestingUrl) === origin))
      );
    }
    if (httpOrigin(requestingOrigin) !== app.origin) return false;
    if (
      (details.embeddingOrigin !== undefined &&
        httpOrigin(details.embeddingOrigin) !== app.origin) ||
      (details.securityOrigin !== undefined && httpOrigin(details.securityOrigin) !== app.origin)
    ) {
      return false;
    }

    // Electron can check notifications without a WebContents. Require both origins;
    // never extend this origin-only exception to capture, clipboard or other permissions.
    if (contents === null) {
      return permission === "notifications" && httpOrigin(details.embeddingOrigin) === app.origin;
    }
    if (
      contents !== app.webContents ||
      !details.isMainFrame ||
      httpOrigin(details.requestingUrl) !== app.origin
    ) {
      return false;
    }

    if (permission === "media") return details.mediaType === "audio";
    return permission === "notifications" || permission === "clipboard-sanitized-write";
  });
}

/** Only the specified hidden profile window may ask for notifications, and nothing else. */
export function installNotificationPermission(
  targetSession: Session,
  webContents: WebContents,
  url: string,
) {
  const origin = httpOrigin(url);
  if (!origin) return () => undefined;
  let targets = notificationTargets.get(targetSession);
  if (!targets) {
    targets = new Map();
    notificationTargets.set(targetSession, targets);
  }
  targets.set(webContents, origin);
  return () => targets?.delete(webContents);
}
