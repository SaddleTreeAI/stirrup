// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertLoginFileOutsideRepo } from "./seed.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

describe("law seed login path", () => {
  it("accepts a path outside the repository", () => {
    expect(assertLoginFileOutsideRepo("/tmp/law-login.txt", repoRoot)).toBe(
      path.resolve("/tmp/law-login.txt"),
    );
  });

  it("refuses a path inside the repository", () => {
    expect(() => assertLoginFileOutsideRepo("editions/law/.law-login", repoRoot)).toThrow(
      /outside the repository/,
    );
  });
});
