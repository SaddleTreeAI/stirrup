import { expect, test } from "@playwright/test";
import type { AccountProfile, RakazoDesktop } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

const savedProfiles: AccountProfile[] = [
  {
    id: "profile-personal",
    label: "Personal account",
    serverUrl: "https://stirrup.example.test",
  },
  {
    id: "profile-work",
    label: "PokéBedrock account",
    serverUrl: "https://stirrup.example.test",
  },
];

test("desktop account menu shows separate accounts on the same host", async ({
  page,
}, testInfo) => {
  await page.addInitScript((profiles) => {
    let activeProfileId = profiles[0]!.id;
    const currentProfiles = [...profiles];
    const profileState = () => ({ activeProfileId, profiles: [...currentProfiles] });
    Object.defineProperty(window, "rakazoDesktop", {
      configurable: true,
      value: {
        platform: "darwin",
        profiles: {
          state: async () => profileState(),
          select: async (profileId: string) => {
            if (!currentProfiles.some((profile) => profile.id === profileId)) return false;
            activeProfileId = profileId;
            return true;
          },
          rename: async (profileId: string, label: string) => {
            const profile = currentProfiles.find((candidate) => candidate.id === profileId);
            if (!profile) return false;
            profile.label = label;
            return true;
          },
          remove: async (profileId: string) => {
            const index = currentProfiles.findIndex((profile) => profile.id === profileId);
            if (index < 0 || profileId === activeProfileId) return false;
            currentProfiles.splice(index, 1);
            return true;
          },
        },
        server: { change: async () => {}, addProfile: async () => {} },
      } satisfies Partial<RakazoDesktop>,
    });
  }, savedProfiles);

  const stamp = Date.now();
  await signup(page, `desktop-profiles-${stamp}@rakazo.test`, "password12", "Profile Tester");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const profiles = page.getByTestId("desktop-account-profiles");
  const openProfiles = async () => {
    await page.getByTestId("user-menu-trigger").click();
    await expect(profiles).toBeHidden();
    await page.getByRole("button", { name: "Saved accounts for Profile Tester" }).click();
    await expect(profiles).toBeVisible();
  };
  await openProfiles();
  const personal = profiles.getByRole("button", { name: /^Personal account https:/ });
  const pokebedrock = profiles.getByRole("button", { name: /^PokéBedrock account https:/ });
  await expect(personal).toHaveAttribute("aria-current", "true");
  await expect(pokebedrock).not.toHaveAttribute("aria-current", "true");
  await expect(profiles.getByText("https://stirrup.example.test", { exact: true })).toHaveCount(2);

  await pokebedrock.click();
  await expect(pokebedrock).toHaveAttribute("aria-current", "true");
  await expect(personal).not.toHaveAttribute("aria-current", "true");
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "desktop-account-profiles-same-host-switcher");

  await profiles.getByRole("button", { name: "Rename Personal account" }).click();
  const rename = page.getByRole("dialog", { name: "Rename account" });
  const name = rename.getByRole("textbox", { name: "Account name" });
  await expect(name).toHaveValue("Personal account");
  await name.fill("Side project");
  await rename.getByRole("button", { name: "Save" }).click();
  await expect(rename).toBeHidden();

  await openProfiles();
  await expect(profiles.getByRole("button", { name: /^Side project https:/ })).toBeVisible();
  await expect(profiles.getByRole("button", { name: "Remove PokéBedrock account" })).toBeDisabled();
  await profiles.getByRole("button", { name: "Remove Side project" }).click();
  const remove = page.getByRole("alertdialog", { name: "Remove Side project from this device?" });
  await remove.getByRole("button", { name: "Remove" }).click();
  await expect(remove).toBeHidden();

  await openProfiles();
  await expect(pokebedrock).toBeVisible();
  await expect(profiles.getByText("Side project")).toHaveCount(0);
});
