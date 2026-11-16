import { describe, expect, it, vi } from "vitest";
import { appStoreFailureMessage, updateAppStoreName } from "../scripts/app-store-name.js";

describe("existing App Store name", () => {
  it("reports a name conflict without exposing account details", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          errors: [
            {
              code: "ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE.DIFFERENT_ACCOUNT",
              detail: "private account details",
            },
          ],
        },
        { status: 409 },
      ),
    );
    const error = await updateAppStoreName({
      appId: "123",
      name: "Stirrup",
      token: "fake",
      fetchImpl,
    }).catch((error) => error);
    expect(appStoreFailureMessage(error)).toBe(
      "The requested App Store name belongs to another account. Choose a different listing name.",
    );
    expect(appStoreFailureMessage(new Error("private network details"))).toBe(
      "App Store name update failed. Check the release credentials and retry.",
    );
  });

  it("updates editable localizations without touching the live version or app identity", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (url.includes("/apps/"))
        return Response.json({
          data: [
            { id: "draft", attributes: { appStoreState: "PREPARE_FOR_SUBMISSION" } },
            { id: "live", attributes: { appStoreState: "READY_FOR_SALE" } },
          ],
        });
      if (url.includes("/appInfos/"))
        return Response.json({
          data: [
            {
              id: url.includes("/draft/") ? "draft-en" : "live-en",
              attributes: { name: "Old name" },
            },
          ],
        });
      expect(options?.method).toBe("PATCH");
      expect(JSON.parse(String(options?.body))).toEqual({
        data: {
          type: "appInfoLocalizations",
          id: "draft-en",
          attributes: { name: "Stirrup", privacyPolicyUrl: "https://saddletree.ai/privacy" },
        },
      });
      return Response.json({ data: {} });
    });
    await expect(
      updateAppStoreName({ appId: "123", name: "Stirrup", token: "fake", fetchImpl }),
    ).resolves.toEqual({ changed: 1, current: 0 });
    expect(fetchImpl.mock.calls.filter(([, options]) => options?.method === "PATCH")).toHaveLength(
      1,
    );
  });

  it("does not repeat a completed rename", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      Response.json({
        data: String(input).includes("/apps/")
          ? [{ id: "draft", attributes: { appStoreState: "PREPARE_FOR_SUBMISSION" } }]
          : [
              {
                id: "en",
                attributes: { name: "Stirrup", privacyPolicyUrl: "https://saddletree.ai/privacy" },
              },
            ],
      }),
    );
    await expect(
      updateAppStoreName({ appId: "123", name: "Stirrup", token: "fake", fetchImpl }),
    ).resolves.toEqual({ changed: 0, current: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports a failed API call without returning its private response body", async () => {
    const fetchImpl = vi.fn(async () => new Response("private account details", { status: 403 }));
    await expect(
      updateAppStoreName({ appId: "123", name: "Stirrup", token: "fake", fetchImpl }),
    ).rejects.toThrow("App Store metadata request failed (403).");
  });

  it("updates an old privacy link even when the listing is already named Stirrup", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      if (options?.method === "PATCH") return Response.json({ data: {} });
      return Response.json({
        data: String(input).includes("/apps/")
          ? [{ id: "draft", attributes: { appStoreState: "PREPARE_FOR_SUBMISSION" } }]
          : [
              {
                id: "en",
                attributes: { name: "Stirrup", privacyPolicyUrl: "https://old.example" },
              },
            ],
      });
    });
    await expect(
      updateAppStoreName({ appId: "123", name: "Stirrup", token: "fake", fetchImpl }),
    ).resolves.toEqual({ changed: 1, current: 0 });
    const patch = fetchImpl.mock.calls.find(([, options]) => options?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body)).data.attributes.privacyPolicyUrl).toBe(
      "https://saddletree.ai/privacy",
    );
  });
});
