import { createRouterClient } from "@orpc/server";
import * as adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = { userId: "user-fixture", spaceId: "space-fixture" } as Actor;
const baseUrl = "https://models.example.com/v1";

describe("failed model probe messages", () => {
  afterEach(() => vi.restoreAllMocks());

  function fixture() {
    const credential = {
      id: "credential-fixture",
      userId: actor.userId,
      provider: "openai-compatible",
      secretId: "secret-fixture",
    };
    const deps = {
      prisma: {
        userModelPreference: { findFirst: vi.fn(async () => null) },
        userModelCredential: {
          findFirst: vi.fn(async () => credential),
          findMany: vi.fn(async () => [credential]),
        },
        secret: {
          findMany: vi.fn(async () => [
            { id: credential.secretId, ciphertext: "fixture-ciphertext" },
          ]),
        },
      },
      secrets: {
        load: vi.fn(async () =>
          JSON.stringify({
            kind: "openai_compatible",
            baseUrl,
            apiKey: "fixture-saved-key",
            headers: { "x-session": "fixture-session-value" },
          }),
        ),
      },
      env: { sandboxProvider: "fake" },
    } as unknown as RouterDeps;
    return createRouterClient(createRouter(deps), { context: { actor } as never });
  }

  it("hides the saved key and headers before answering a failed endpoint probe", async () => {
    vi.spyOn(adapters, "probeOpenAiCompatibleModels").mockRejectedValue(
      new TypeError("The endpoint refused fixture-saved-key with fixture-session-value."),
    );
    await expect(fixture().models.probeOpenAiCompatible({ baseUrl })).rejects.toThrow(
      "The endpoint refused ••• with •••.",
    );
    expect(adapters.probeOpenAiCompatibleModels).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "fixture-saved-key",
        headers: { "x-session": "fixture-session-value" },
      }),
      undefined,
      undefined,
      expect.anything(),
    );
  });

  it("hides the submitted key before answering a failed catalog probe", async () => {
    vi.spyOn(adapters, "probeCatalogProviderModels").mockRejectedValue(
      new Error("The catalog refused fixture-catalog-key."),
    );
    await expect(
      fixture().models.probeCatalog({ provider: "openai", apiKey: "fixture-catalog-key" }),
    ).rejects.toThrow("The catalog refused •••.");
  });
});
