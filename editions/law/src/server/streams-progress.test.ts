// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { describe, expect, it } from "vitest";
import { lawStreamsProgress } from "./streams-progress.js";

describe("lawStreamsProgress", () => {
  it("returns true only for law-mock", () => {
    expect(lawStreamsProgress("law-mock")).toBe(true);
    expect(lawStreamsProgress(undefined)).toBe(false);
    expect(lawStreamsProgress("pi")).toBe(false);
    expect(lawStreamsProgress("scripted")).toBe(false);
  });
});
