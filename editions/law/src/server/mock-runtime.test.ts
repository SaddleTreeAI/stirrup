// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { LawMockAgentRuntime, lawMockEnabled } from "./mock-runtime.js";

describe("law mock runtime", () => {
  it("describes itself as law-mock", () => {
    expect(new LawMockAgentRuntime(0).describe().id).toBe("law-mock");
  });

  it("streams thinking lifecycle then the reply for the named case", async () => {
    const runtime = new LawMockAgentRuntime(40);
    const events = [];
    for await (const event of runtime.run(request())) events.push(event);
    expect(events.some((event) => event.type === "thinking" && event.active)).toBe(true);
    expect(events.some((event) => event.type === "thinking" && !event.active)).toBe(true);
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => (event.type === "text" ? event.text : ""))
      .join("");
    expect(text).toContain("On Commonwealth v. Ward:");
    expect(text).toContain("where was the car");
    expect(events.filter((event) => event.type === "text").length).toBeGreaterThan(1);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("files a generator reply as a synthetic draft", async () => {
    const runtime = new LawMockAgentRuntime(0);
    let text = "";
    for await (const event of runtime.run(
      request("You are the Legal Doc Generator.\n\nCase brief:\nCommonwealth v. Nunez"),
    )) {
      if (event.type === "text") text += event.text;
    }
    expect(text.startsWith("SYNTHETIC DRAFT — NOT FOR FILING")).toBe(true);
    expect(text).toContain("Commonwealth v. Nunez");
    expect(text).not.toContain("Ward");
  });

  it("enables the mock only when pinned and the law key is unset", () => {
    expect(lawMockEnabled({ LAW_ENFORCE_CHAT_PIN: "1" })).toBe(true);
    expect(lawMockEnabled({ LAW_ENFORCE_CHAT_PIN: "1", LAW_OPENROUTER_API_KEY: "key" })).toBe(
      false,
    );
    expect(lawMockEnabled({ LAW_ENFORCE_CHAT_PIN: "1", LAW_OPENROUTER_API_KEY: "  " })).toBe(true);
    expect(lawMockEnabled({})).toBe(false);
  });
});

function request(instructions = "Case brief:\nCommonwealth v. Ward\n"): AgentRunRequest {
  return {
    runId: "run-1",
    prompt: "where was the car",
    instructions,
    history: [],
    tools: [],
    model: { provider: "openrouter", id: "qwen/qwen3.8-27b" },
  } as unknown as AgentRunRequest;
}
