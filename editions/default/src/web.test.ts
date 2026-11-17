import { describe, expect, it } from "vitest";
import { edition } from "./web.js";

describe("default web edition", () => {
  it("useShellExtension returns the same object across calls", () => {
    expect(edition.useShellExtension()).toBe(edition.useShellExtension());
  });
});
