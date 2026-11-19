import { describe, expect, it, vi } from "vitest";
import type { EditionBotAccess } from "./server.js";
import { defineServerEdition } from "./server.js";

describe("defineServerEdition botAccess", () => {
  it("defaults botAccess to undefined", () => {
    expect(defineServerEdition({ id: "default" }).botAccess).toBeUndefined();
  });

  it("passes a supplied botAccess through", () => {
    const botAccess: EditionBotAccess = vi.fn(async () => "allow" as const);
    expect(defineServerEdition({ id: "custom", botAccess }).botAccess).toBe(botAccess);
  });
});
