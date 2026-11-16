import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openBotPanelTab, rpc, signup } from "./helpers";

test("sidebar tools stay visible in visual and keyboard order", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1400, height: 900 });
  await signup(page, `sidebar-tools-${Date.now()}@rakazo.test`, "password12", "Sidebar Sample");
  await completeOnboarding(page);
  const sidebar = page.getByTestId("bots-sidebar");
  const tools = [
    sidebar.getByTestId("sidebar-search-trigger"),
    sidebar.getByTestId("create-menu-trigger"),
    sidebar.getByRole("button", { name: "Activity", exact: true }),
    sidebar.getByTestId("minimize-bots-sidebar"),
  ];
  await page.mouse.move(700, 450);
  for (const tool of tools) {
    await expect(tool).toBeVisible();
    await expect(tool).toHaveCSS("opacity", "1");
  }
  const positions = await Promise.all(tools.map((tool) => tool.boundingBox()));
  for (let index = 1; index < positions.length; index++) {
    expect(positions[index]!.x).toBeGreaterThan(positions[index - 1]!.x);
  }
  await tools[0]!.focus();
  for (const tool of tools.slice(1)) {
    await page.keyboard.press("Tab");
    await expect(tool).toBeFocused();
  }
  await tools[3]!.blur();
  await captureScreenshot(page, testInfo, "sidebar-tools-always-visible");
});

test("open work wraps long titles and notes inside a narrow panel", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1400, height: 900 });
  await signup(page, `work-wrap-${Date.now()}@rakazo.test`, "password12", "Work Sample");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);
  const title = `Review ${"a".repeat(120)}`;
  const notes = `Revision ${"b".repeat(240)}\nhttps://example.test/${"reference".repeat(50)}`;
  await rpc(page, "scratchpad/create", {
    botId: new URL(page.url()).pathname.split("/").at(-1),
    title,
    notes,
  });
  await openBotPanelTab(page, "Advanced");
  const panel = page.getByTestId("side-panel");
  const separator = page.getByRole("separator", { name: "Resize panel" });
  await separator.focus();
  await separator.press("Home");
  await expect(panel).toHaveCSS("width", "320px");
  const work = panel.getByTestId("bot-scratchpad");
  await expect(work.getByText(title, { exact: true })).toBeVisible();
  await expect(work.getByText(notes, { exact: true })).toBeVisible();
  for (const box of [panel, work]) {
    await expect.poll(() => box.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
  }
  await captureScreenshot(page, testInfo, "open-work-long-text-wrapped");
});
