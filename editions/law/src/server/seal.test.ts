// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { randomBytes } from "node:crypto";
import type { ContentEncryption, SpaceKeyRecord, SpaceKeyStore } from "@rakazo/db";
import {
  CIPHERTEXT_PREFIX,
  ContentDecryptionError,
  ContentKeyRing,
  isCiphertext,
  LocalKeyProvider,
} from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { openLawText, sealLawText } from "./seal.js";

function memoryStore() {
  const rows: SpaceKeyRecord[] = [];
  const store: SpaceKeyStore = {
    async forSpace(spaceId) {
      return rows.filter((row) => row.spaceId === spaceId).sort((a, b) => a.version - b.version);
    },
    async byId(id) {
      return rows.find((row) => row.id === id);
    },
    async insert(record) {
      const existing = rows.find(
        (row) => row.spaceId === record.spaceId && row.version === record.version,
      );
      if (existing) return existing;
      rows.push(record);
      return record;
    },
    async sampleByMasterKey() {
      return [...new Map(rows.map((row) => [row.masterKeyId, row])).values()];
    },
    async rowContext() {
      return undefined;
    },
  };
  return store;
}

function prismaWithRing(ring: ContentKeyRing) {
  const handle: ContentEncryption = {
    ring,
    openRows: async (_model, rows) => rows,
    sealRow: async (_model, row) => row,
    messageSearchTokens: async () => [],
  };
  return { $contentEncryption: () => handle };
}

const location = {
  table: "law_documents" as const,
  column: "body",
  rowId: "doc-1",
  spaceId: "space-1",
  owner: "case-1",
};

describe("sealLawText / openLawText", () => {
  it("round-trips with the space data key", async () => {
    const ring = new ContentKeyRing(
      new LocalKeyProvider([{ id: "a", key: randomBytes(32) }]),
      memoryStore(),
    );
    const prisma = prismaWithRing(ring);
    const sealed = await sealLawText(prisma, location, "synthetic body");
    expect(sealed.startsWith(CIPHERTEXT_PREFIX)).toBe(true);
    expect(isCiphertext(sealed)).toBe(true);
    await expect(openLawText(prisma, location, sealed)).resolves.toBe("synthetic body");
  });

  it("writes plaintext when encryption writes are off", async () => {
    const ring = new ContentKeyRing(
      new LocalKeyProvider([{ id: "a", key: randomBytes(32) }]),
      memoryStore(),
      { encryptWrites: false },
    );
    const prisma = prismaWithRing(ring);
    await expect(sealLawText(prisma, location, "plain")).resolves.toBe("plain");
  });

  it("reads both ciphertext and legacy plaintext", async () => {
    const ring = new ContentKeyRing(
      new LocalKeyProvider([{ id: "a", key: randomBytes(32) }]),
      memoryStore(),
    );
    const prisma = prismaWithRing(ring);
    const sealed = await sealLawText(prisma, location, "sealed once");
    await expect(openLawText(prisma, location, sealed)).resolves.toBe("sealed once");
    await expect(openLawText(prisma, location, "legacy plain")).resolves.toBe("legacy plain");
  });

  it("fails to decrypt when the row id does not match", async () => {
    const ring = new ContentKeyRing(
      new LocalKeyProvider([{ id: "a", key: randomBytes(32) }]),
      memoryStore(),
    );
    const prisma = prismaWithRing(ring);
    const sealed = await sealLawText(prisma, location, "bound to row");
    await expect(
      openLawText(prisma, { ...location, rowId: "doc-other" }, sealed),
    ).rejects.toBeInstanceOf(ContentDecryptionError);
  });

  it("passes plaintext through when no encrypting client is attached", async () => {
    await expect(sealLawText({}, location, "no ring")).resolves.toBe("no ring");
    await expect(openLawText({}, location, "no ring")).resolves.toBe("no ring");
  });

  it("prefixes lookalike ciphertext when writes are off", async () => {
    const ring = new ContentKeyRing(
      new LocalKeyProvider([{ id: "a", key: randomBytes(32) }]),
      memoryStore(),
      { encryptWrites: false },
    );
    const prisma = prismaWithRing(ring);
    const lookalike = `${CIPHERTEXT_PREFIX}key-1:abc`;
    const stored = await sealLawText(prisma, location, lookalike);
    expect(stored.startsWith("\u200b")).toBe(true);
    expect(isCiphertext(stored)).toBe(false);
  });
});
