// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { describe, expect, it } from "vitest";
import {
  applyLawChatPin,
  assertLawChatPin,
  assertLawDeploymentChatPin,
  lawMockLatencyMs,
  pinOpenRouterBody,
} from "./chat-pin.js";
import { LAW_CHAT_MODEL_ID, LAW_CHAT_PROVIDER } from "./constants.js";
import { lawMockEnabled } from "./mock-runtime.js";

describe("law chat pin", () => {
  it("rejects any other chat model or provider key", () => {
    expect(() => assertLawChatPin({ PI_DEFAULT_MODEL: "anthropic/claude-haiku-5.5" })).toThrow(
      /PI_DEFAULT_MODEL/,
    );
    expect(() => assertLawChatPin({ PI_DEFAULT_PROVIDER: "anthropic" })).toThrow(
      /PI_DEFAULT_PROVIDER/,
    );
    expect(() => assertLawChatPin({ ANTHROPIC_API_KEY: "sk-test" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => assertLawChatPin({ OPENROUTER_API_KEY: "other" })).toThrow(/OPENROUTER_API_KEY/);
    expect(() => assertLawChatPin({ AGENT_RUNTIME: "scripted" })).toThrow(/AGENT_RUNTIME/);
  });

  it("accepts the pinned model and copies the law key", () => {
    const env: NodeJS.ProcessEnv = { LAW_OPENROUTER_API_KEY: "law-key" };
    applyLawChatPin(env);
    expect(env.PI_DEFAULT_MODEL).toBe(LAW_CHAT_MODEL_ID);
    expect(env.PI_DEFAULT_PROVIDER).toBe(LAW_CHAT_PROVIDER);
    expect(env.OPENROUTER_API_KEY).toBe("law-key");
    expect(env.LAW_ENFORCE_CHAT_PIN).toBe("1");
    expect(lawMockEnabled(env)).toBe(false);
  });

  it("uses the slow mock when the law key is unset", () => {
    const env: NodeJS.ProcessEnv = {};
    applyLawChatPin(env);
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(lawMockEnabled(env)).toBe(true);
    expect(lawMockLatencyMs({})).toBe(40_000);
    expect(lawMockLatencyMs({ LAW_MOCK_LATENCY_MS: "45000" })).toBe(45_000);
    expect(lawMockLatencyMs({ LAW_MOCK_LATENCY_MS: "5" })).toBe(40_000);
  });

  it("treats blank or whitespace law keys as unset", () => {
    const env: NodeJS.ProcessEnv = { LAW_OPENROUTER_API_KEY: "  " };
    applyLawChatPin(env);
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(lawMockEnabled(env)).toBe(true);
  });

  it("pins OpenRouter provider settings and refuses a different model", () => {
    const body = pinOpenRouterBody(JSON.stringify({ model: LAW_CHAT_MODEL_ID, messages: [] }));
    expect(JSON.parse(body).provider).toEqual({
      quantizations: ["fp8"],
      allow_fallbacks: false,
    });
    expect(() => pinOpenRouterBody(JSON.stringify({ model: "other" }))).toThrow(
      /unpinned_chat_model/,
    );
  });
});

describe("law deployment chat pin", () => {
  it("passes when deployment defaults are unset", async () => {
    await expect(
      assertLawDeploymentChatPin({
        deploymentSettings: {
          findUnique: async () => ({ defaultModelProvider: null, defaultModelId: null }),
        },
      } as never),
    ).resolves.toBeUndefined();
  });

  it("passes when deployment defaults match the pin", async () => {
    await expect(
      assertLawDeploymentChatPin({
        deploymentSettings: {
          findUnique: async () => ({
            defaultModelProvider: LAW_CHAT_PROVIDER,
            defaultModelId: LAW_CHAT_MODEL_ID,
          }),
        },
      } as never),
    ).resolves.toBeUndefined();
  });

  it("throws when deployment provider is another value", async () => {
    await expect(
      assertLawDeploymentChatPin({
        deploymentSettings: {
          findUnique: async () => ({
            defaultModelProvider: "anthropic",
            defaultModelId: null,
          }),
        },
      } as never),
    ).rejects.toThrow(/^chat model pin:/);
  });

  it("throws when deployment model is another value", async () => {
    await expect(
      assertLawDeploymentChatPin({
        deploymentSettings: {
          findUnique: async () => ({
            defaultModelProvider: LAW_CHAT_PROVIDER,
            defaultModelId: "other-model",
          }),
        },
      } as never),
    ).rejects.toThrow(/^chat model pin:/);
  });
});
