import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accountProfileFilePath,
  parseDesktopProfileStore,
  profileFromSetup,
  readDesktopProfileStore,
  safeProfileLabel,
  writeDesktopProfileStore,
} from "./account-profile-store.js";

let userData: string;

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "rakazo-profiles-"));
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("desktop account profile store", () => {
  it("keeps multiple accounts on one host in separate profile records", async () => {
    const first = profileFromSetup(
      { mode: "existing", serverUrl: "https://bots.example.com" },
      true,
    );
    const second = profileFromSetup({ mode: "existing", serverUrl: "https://bots.example.com" });
    const store = {
      version: 1 as const,
      activeProfileId: second.id,
      profiles: [first, second],
    };

    await writeDesktopProfileStore(userData, store);

    await expect(readDesktopProfileStore(userData)).resolves.toEqual(store);
    const file = await stat(accountProfileFilePath(userData));
    expect(file.mode & 0o777).toBe(0o600);
  });

  it("never writes passwords or custom headers to the public profile metadata", async () => {
    const profile = profileFromSetup({
      mode: "existing",
      serverUrl: "https://bots.example.com",
      headers: { Authorization: "Bearer test-secret" },
    });
    await writeDesktopProfileStore(userData, {
      version: 1,
      activeProfileId: profile.id,
      profiles: [profile],
    });

    const saved = await readFile(accountProfileFilePath(userData), "utf8");
    expect(saved).toContain("test-secret");
    expect(
      JSON.stringify({ id: profile.id, label: profile.label, serverUrl: profile.serverUrl }),
    ).not.toContain("test-secret");
  });

  it("rejects corrupt, duplicate, and unvalidated profile records", () => {
    const profile = profileFromSetup({ mode: "existing", serverUrl: "https://bots.example.com" });
    expect(
      parseDesktopProfileStore({
        version: 1,
        activeProfileId: profile.id,
        profiles: [profile, profile],
      }),
    ).toBeNull();
    expect(
      parseDesktopProfileStore({ version: 1, activeProfileId: "missing", profiles: [profile] }),
    ).toBeNull();
    expect(
      parseDesktopProfileStore({
        version: 1,
        activeProfileId: profile.id,
        profiles: [{ ...profile, setup: { mode: "existing", serverUrl: "javascript:alert(1)" } }],
      }),
    ).toBeNull();
  });

  it("trims safe labels and rejects control characters", () => {
    expect(safeProfileLabel("  Personal  ")).toBe("Personal");
    expect(safeProfileLabel("bad\nlabel")).toBeNull();
    expect(safeProfileLabel(" ")).toBeNull();
  });
});
