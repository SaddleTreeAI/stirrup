// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { lawMockLatencyMs } from "./chat-pin.js";
import { LAW_CHAT_MODEL_ID, LAW_CHAT_PROVIDER } from "./constants.js";

const running = new Map<string, AbortController>();

/** True after startup has pinned chat, and no OpenRouter key is configured. */
export function lawMockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LAW_ENFORCE_CHAT_PIN === "1" && !env.LAW_OPENROUTER_API_KEY?.trim();
}

/**
 * Offline stand-in for the pinned chat model. It streams reasoning, then a reply,
 * over 30–60 seconds, through the same run events a live model uses.
 */
export class LawMockAgentRuntime implements AgentRuntime {
  constructor(private readonly latencyMs = lawMockLatencyMs()) {}

  describe() {
    return {
      id: "law-mock",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      // Scripted so a turn can start with no provider key. Text still streams.
      capabilities: { streaming: true, compaction: false, tools: true, scripted: true },
    };
  }

  async abort(runId: string): Promise<void> {
    running.get(runId)?.abort();
  }

  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    const controller = new AbortController();
    running.set(request.runId, controller);
    const signal = context?.signal
      ? AbortSignal.any([controller.signal, context.signal])
      : controller.signal;
    try {
      const reply = mockReply(request);
      const thinkMs = Math.round(this.latencyMs * 0.25);
      const replyMs = Math.max(0, this.latencyMs - thinkMs);
      // Stirrup thinking events are lifecycle-only (no reasoning text on the event).
      yield { type: "thinking", active: true };
      for (let step = 0; step < 4; step += 1) {
        await delay(thinkMs / 4, signal);
        if (signal.aborted) {
          yield { type: "done", text: "stopped" };
          return;
        }
      }
      yield { type: "thinking", active: false };
      for (const part of split(reply.text, 8)) {
        await delay(replyMs / 8, signal);
        if (signal.aborted) {
          yield { type: "done", text: "stopped" };
          return;
        }
        yield { type: "text", text: part };
      }
      yield {
        type: "usage",
        inputTokens: 8,
        outputTokens: 24,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        provider: LAW_CHAT_PROVIDER,
        model: LAW_CHAT_MODEL_ID,
      };
      yield { type: "done", text: reply.text };
    } finally {
      controller.abort();
      running.delete(request.runId);
    }
  }
}

function mockReply(request: AgentRunRequest): { thinking: string; text: string } {
  const instructions = request.instructions ?? "";
  const prompt = request.prompt ?? "";
  const caseName =
    /^Case: (.+)$/m.exec(prompt)?.[1]?.trim() ||
    /Commonwealth v\. [A-Za-z]+/.exec(`${instructions}\n${prompt}`)?.[0] ||
    "this case";
  const ask = userAsk(prompt);
  const thinking = `Looking at ${caseName}. The question is: ${ask.slice(0, 180)}`;
  const generator = /You are the Legal Doc Generator/.test(instructions);
  const text = generator
    ? `SYNTHETIC DRAFT — NOT FOR FILING\n\nDraft for ${caseName}.\n\n${ask.slice(0, 600)}\n\nThis draft is for attorney review only.`
    : `On ${caseName}: ${ask.slice(0, 600)}`;
  return { thinking, text };
}

function userAsk(prompt: string): string {
  const lines = prompt
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !line.startsWith("Case:") &&
        !line.startsWith("Brief:") &&
        !line.startsWith("Retrieved") &&
        !line.startsWith("###") &&
        !line.startsWith("Current time") &&
        !line.startsWith("SYNTHETIC"),
    );
  return lines.at(-1) ?? "";
}

function split(text: string, parts: number): string[] {
  if (!text) return [""];
  const size = Math.ceil(text.length / parts);
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size)
    chunks.push(text.slice(index, index + size));
  return chunks;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
