// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { PrismaClient } from "@rakazo/db";
import { LAW_CHAT_MODEL_ID, LAW_CHAT_PROVIDER } from "./constants.js";

const FORBIDDEN_CHAT_ENV = [
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "RAKAZO_LOCAL_MODELS",
] as const;

/**
 * Refuse to start when the process is configured for any chat model other than
 * the pinned OpenRouter model. The key is LAW_OPENROUTER_API_KEY.
 */
export function assertLawChatPin(env: NodeJS.ProcessEnv = process.env): void {
  const provider = env.PI_DEFAULT_PROVIDER?.trim();
  if (provider && provider !== LAW_CHAT_PROVIDER) {
    throw new Error(`chat model pin: PI_DEFAULT_PROVIDER must be openrouter, got ${provider}`);
  }
  const model = env.PI_DEFAULT_MODEL?.trim();
  if (model && model !== LAW_CHAT_MODEL_ID) {
    throw new Error(`chat model pin: PI_DEFAULT_MODEL must be ${LAW_CHAT_MODEL_ID}, got ${model}`);
  }
  const runtime = env.AGENT_RUNTIME?.trim();
  if (runtime && runtime !== "pi") {
    throw new Error(`chat model pin: AGENT_RUNTIME must be pi, got ${runtime}`);
  }
  for (const name of FORBIDDEN_CHAT_ENV) {
    if (env[name]?.trim()) {
      throw new Error(`chat model pin: ${name} is set; only ${LAW_CHAT_MODEL_ID} is allowed`);
    }
  }
  const lawKey = env.LAW_OPENROUTER_API_KEY?.trim() ?? "";
  const openRouterKey = env.OPENROUTER_API_KEY?.trim() ?? "";
  if (openRouterKey && openRouterKey !== lawKey) {
    throw new Error(
      "chat model pin: OPENROUTER_API_KEY must match LAW_OPENROUTER_API_KEY, or be unset",
    );
  }
}

/** Slow mock latency. An explicit value must sit between 30 and 60 seconds. */
export function lawMockLatencyMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.LAW_MOCK_LATENCY_MS);
  if (Number.isFinite(raw) && raw >= 30_000 && raw <= 60_000) return raw;
  return 40_000;
}

/** Force the fp8 pin on an OpenRouter chat body. Any other model is refused. */
export function pinOpenRouterBody(body: string): string {
  const parsed = JSON.parse(body) as { model?: unknown; provider?: unknown };
  const model = typeof parsed.model === "string" ? parsed.model : "";
  if (model !== LAW_CHAT_MODEL_ID) {
    throw new Error(`unpinned_chat_model:${model || "missing"}`);
  }
  parsed.provider = { quantizations: ["fp8"], allow_fallbacks: false };
  return JSON.stringify(parsed);
}

let fetchPatched = false;

/**
 * Pin the process to the law chat model. Copies the law key onto the OpenRouter
 * key the runtime already reads. With no key, chat uses the slow mock.
 * Always applied in this edition (sets LAW_ENFORCE_CHAT_PIN for lawMockEnabled).
 */
export function applyLawChatPin(env: NodeJS.ProcessEnv = process.env): void {
  assertLawChatPin(env);
  env.PI_DEFAULT_PROVIDER = LAW_CHAT_PROVIDER;
  env.PI_DEFAULT_MODEL = LAW_CHAT_MODEL_ID;
  env.LAW_ENFORCE_CHAT_PIN = "1";
  const key = env.LAW_OPENROUTER_API_KEY?.trim();
  if (key) env.OPENROUTER_API_KEY = key;
  else delete env.OPENROUTER_API_KEY;
  if (fetchPatched || env !== process.env) return;
  fetchPatched = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes("openrouter.ai/") || !url.includes("/chat/completions")) {
      return original(input, init);
    }
    const raw = typeof init?.body === "string" ? init.body : undefined;
    if (!raw) return original(input, init);
    const body = pinOpenRouterBody(raw);
    return original(input, { ...init, body });
  };
}

/**
 * Refuse to start when deployment settings name another default chat model.
 * Unset provider/model are allowed (the pin supplies them at process start).
 */
export async function assertLawDeploymentChatPin(
  prisma: Pick<PrismaClient, "deploymentSettings">,
): Promise<void> {
  const pinned = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  if (pinned?.defaultModelProvider && pinned.defaultModelProvider !== LAW_CHAT_PROVIDER) {
    throw new Error(`chat model pin: deployment provider is ${pinned.defaultModelProvider}`);
  }
  if (pinned?.defaultModelId && pinned.defaultModelId !== LAW_CHAT_MODEL_ID) {
    throw new Error(`chat model pin: deployment model is ${pinned.defaultModelId}`);
  }
}
