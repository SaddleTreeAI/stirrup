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
          rename: async () => true,
          remove: async () => true,
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

  await page.getByTestId("user-menu-trigger").click();
  const profiles = page.getByTestId("desktop-account-profiles");
  await expect(profiles).toBeVisible();
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
});
