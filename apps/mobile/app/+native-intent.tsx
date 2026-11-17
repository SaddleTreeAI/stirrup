import { receiveIncomingShare } from "../lib/incoming-share";
import { closeSettingsSheet, isSettingsLink, linkScreen } from "../lib/settings-sheet";

/** A link to a screen outside settings closes the settings sheet first, so the screen opens on
 * the root stack instead of over the sheet. Settings links open inside the sheet. Something
 * shared from another app (expo-sharing opens `rakazo://expo-sharing`) opens the share target screen. */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  const isShare = linkScreen(path) === "expo-sharing";
  receiveIncomingShare(isShare, initial);
  if (!isSettingsLink(path)) closeSettingsSheet();
  // Native Android push notifications use this gated route so the app can
  // select the exact saved account before rendering a thread screen.
  if (path.startsWith("rakazo://push-target?") || path.startsWith("rakazo:///push-target?")) {
    return path.replace(/^rakazo:\/\/?\/?push-target/, "/push-target");
  }
  return isShare ? "/share" : path;
}
