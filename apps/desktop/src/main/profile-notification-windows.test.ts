import type { BrowserWindow, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  notificationProfileForSender,
  trustedNotificationProfileForSender,
} from "./profile-notification-windows.js";

describe("inactive profile notification sender mapping", () => {
  it("maps only the registered live window to its profile", () => {
    const sender = {} as WebContents;
    const retiredSender = {} as WebContents;
    const windowFor = (webContents: WebContents, destroyed = false) =>
      ({ webContents, isDestroyed: vi.fn(() => destroyed) }) as unknown as BrowserWindow;
    const windows = new Map([
      ["profile-a", { win: windowFor(sender) }],
      ["profile-b", { win: windowFor(retiredSender, true) }],
    ]);

    expect(notificationProfileForSender(windows, sender)).toBe("profile-a");
    expect(notificationProfileForSender(windows, retiredSender)).toBeUndefined();
    expect(notificationProfileForSender(windows, {} as WebContents)).toBeUndefined();
  });

  it("trusts only the registered inactive profile's own main frame and exact server", () => {
    const mainFrame = {};
    const sender = {
      mainFrame,
      getURL: () => "https://account.example/app",
      isDestroyed: () => false,
    } as unknown as WebContents;
    const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
    const windows = new Map([["profile-a", { win: window }]]);
    const profiles = [{ id: "profile-a", serverUrl: "https://account.example" }] as never[];

    expect(
      trustedNotificationProfileForSender(windows, profiles, null, sender, mainFrame as never),
    ).toBe("profile-a");
    expect(
      trustedNotificationProfileForSender(
        windows,
        profiles,
        "profile-a",
        sender,
        mainFrame as never,
      ),
    ).toBeUndefined();
    expect(
      trustedNotificationProfileForSender(windows, profiles, null, sender, {} as never),
    ).toBeUndefined();
    expect(
      trustedNotificationProfileForSender(
        windows,
        profiles,
        null,
        {
          ...sender,
          getURL: () => "https://other.example/app",
        } as WebContents,
        mainFrame as never,
      ),
    ).toBeUndefined();
    expect(
      trustedNotificationProfileForSender(
        windows,
        profiles,
        null,
        {
          ...sender,
          isDestroyed: () => true,
        } as WebContents,
        mainFrame as never,
      ),
    ).toBeUndefined();
  });
});
