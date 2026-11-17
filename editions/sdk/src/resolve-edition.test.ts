import { describe, expect, it } from "vitest";
import { defineServerEdition, resolveEdition } from "./server.js";

describe("resolveEdition", () => {
  const registry = {
    default: defineServerEdition({ id: "default" }),
    law: defineServerEdition({ id: "law" }),
  };

  it("returns the edition for a known id", () => {
    expect(resolveEdition("default", registry).id).toBe("default");
    expect(resolveEdition("law", registry).id).toBe("law");
  });

  it("throws a clear error for an unknown id", () => {
    expect(() => resolveEdition("nope", registry)).toThrow(
      /Unknown edition "nope"\. Known editions: default, law/,
    );
  });
});
