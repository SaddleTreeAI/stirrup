// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { isBotAvatarValue } from "@rakazo/contracts";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { LAW_CASE_ROLES, LAW_ROLE_AVATARS, lawRoleAvatar } from "./avatars.js";

const ROLE_AVATAR_MAX_CHARS = 40_000;

describe("LAW_ROLE_AVATARS", () => {
  it("exports a data URL per case role under the length cap", () => {
    for (const role of LAW_CASE_ROLES) {
      const value = LAW_ROLE_AVATARS[role];
      expect(lawRoleAvatar(role)).toBe(value);
      expect(value.length).toBeLessThanOrEqual(ROLE_AVATAR_MAX_CHARS);
      expect(isBotAvatarValue(value)).toBe(true);
      expect(value.startsWith("data:image/webp;base64,")).toBe(true);
    }
    expect(lawRoleAvatar("custom:other")).toBeUndefined();
  });

  it("decodes each tile to a 256x256 webp", async () => {
    for (const role of LAW_CASE_ROLES) {
      const value = LAW_ROLE_AVATARS[role];
      const base64 = value.slice("data:image/webp;base64,".length);
      const buffer = Buffer.from(base64, "base64");
      const meta = await sharp(buffer).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.width).toBe(256);
      expect(meta.height).toBe(256);
    }
  });
});
