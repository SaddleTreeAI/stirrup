import { randomUUID } from "node:crypto";
import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("a platform owner reviews people and opens an invitation", async ({ page }, testInfo) => {
  await signup(page, `platform-owner-${randomUUID()}@rakazo.test`, "password12", "Workspace owner");
  await completeOnboarding(page);
  const owner = async (route: Route) => {
    const response = await route.fetch();
    const body = await response.json();
    const me = body.json?.me ?? body.json;
    me.platformMode = true;
    me.platformRole = "owner";
    await route.fulfill({ response, json: body });
  };
  await page.route("**/rpc/me", owner);
  await page.route("**/rpc/bootstrap", owner);
  await page.route(/\/rpc\/platformAdmin\/overview(\?|$)/, (route) =>
    route.fulfill({
      json: {
        json: {
          users: 2,
          activeUsers: 2,
          pendingInvites: 0,
          monthToDateCostUsd: 12.34,
          monthToDateInputTokens: 4000,
          monthToDateOutputTokens: 1200,
          monthToDateCalls: 28,
        },
      },
    }),
  );
  await page.route(/\/rpc\/platformAdmin\/users\/list(\?|$)/, (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: "example-member",
            name: "Alex Example",
            email: "alex@example.test",
            emailVerified: true,
            role: "member",
            active: true,
            createdAt: "2026-01-01T00:00:00Z",
            monthlyBudgetUsd: 100,
            monthToDateCostUsd: 12.34,
            monthToDateInputTokens: 4000,
            monthToDateOutputTokens: 1200,
            monthToDateCalls: 28,
          },
        ],
      },
    }),
  );
  await page.route(/\/rpc\/platformAdmin\/users\/invites(\?|$)/, (route) =>
    route.fulfill({ json: { json: [] } }),
  );
  for (const endpoint of ["providers/available", "providers/list"]) {
    await page.route(new RegExp(`/rpc/platformAdmin/${endpoint}(\\?|$)`), (route) =>
      route.fulfill({ json: { json: [] } }),
    );
  }
  await page.route(/\/rpc\/platformAdmin\/bots\/listForUser(\?|$)/, (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: "shared-planner",
            spaceId: "company-space",
            spaceName: "Company",
            name: "Shared Planner",
            ownerUserId: "example-member",
            ownerName: "Alex Example",
            ownerEmail: "alex@example.test",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    }),
  );
  await page.route(/\/rpc\/platformAdmin\/bots\/inspect(\?|$)/, (route) =>
    route.fulfill({
      json: {
        json: {
          bot: {
            id: "shared-planner",
            spaceId: "company-space",
            spaceName: "Company",
            name: "Shared Planner",
            ownerUserId: "example-member",
            ownerName: "Alex Example",
            ownerEmail: "alex@example.test",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            description: "Plans company work.",
            instructions: "Keep the company team coordinated.",
            modelProvider: null,
            modelId: null,
            archivedAt: null,
          },
          threads: [
            {
              id: "ops-thread",
              label: "Operations",
              kind: "group",
              createdAt: "2026-01-02T00:00:00.000Z",
            },
          ],
          selectedThreadId: "ops-thread",
          nextThreadsBefore: null,
          messages: [
            {
              id: "ops-message",
              threadId: "ops-thread",
              seq: 1,
              role: "assistant",
              authorUserId: null,
              blocks: [{ kind: "text", text: "Operations are ready." }],
              createdAt: "2026-01-02T00:01:00.000Z",
            },
          ],
          nextBefore: null,
          memories: [],
          nextMemoriesBefore: null,
          files: [
            {
              id: "ops-archive",
              name: "operations-archive.zip",
              description: null,
              mimeType: "application/zip",
              size: 10_485_761,
              createdAt: "2026-01-02T00:02:00.000Z",
            },
          ],
          nextFilesBefore: null,
          usage: [],
          nextUsageBefore: null,
        },
      },
    }),
  );
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Administration" })).toBeVisible();
  await expect(page.getByTestId("platform-people").getByText("Alex Example")).toBeVisible();
  await captureScreenshot(page, testInfo, "platform-administration");
  await page.getByTestId("platform-people").getByRole("button").click();
  const person = page.getByRole("dialog");
  await expect(person.getByText("Company model budget")).toBeVisible();
  await captureScreenshot(page, testInfo, "platform-person");
  const inspection = page.getByTestId("platform-owner-bot-inspection");
  await inspection.getByRole("button", { name: /Shared Planner/ }).click();
  await expect(inspection.getByRole("heading", { name: "Conversations" })).toBeVisible();
  await expect(inspection.getByText("Operations are ready.")).toBeVisible();
  await expect(
    inspection.getByText("Files download as a stream, including large files."),
  ).toBeVisible();
  await expect(inspection.getByRole("button", { name: "Download" })).toBeEnabled();
  await captureScreenshot(page, testInfo, "platform-owner-bot-inspection");
  await page.route("**/api/platform-admin/bots/shared-planner/files/ops-archive", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": "attachment; filename*=UTF-8''operations-archive.zip",
      },
      body: Buffer.alloc(12 * 1024 * 1024, 0x5a),
    }),
  );
  const downloaded = page.waitForEvent("download");
  await inspection.getByRole("button", { name: "Download" }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("operations-archive.zip");
  expect(await download.failure()).toBeNull();
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  let receivedBytes = 0;
  for await (const chunk of stream!) receivedBytes += chunk.length;
  expect(receivedBytes).toBe(12 * 1024 * 1024);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Invite person" }).click();
  await expect(page.getByRole("dialog").getByLabel("Email", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "platform-invitation");
});
