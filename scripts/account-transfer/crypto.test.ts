import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  fingerprint,
  fromJsonValue,
  openRecipientEnvelope,
  sealForRecipient,
  toJsonValue,
} from "./crypto.js";

describe("selective account-transfer primitives", () => {
  it("seals envelope payloads to one recipient and authenticates their context", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const secret = Buffer.from("fixture credential only");
    const envelope = sealForRecipient(publicKey, secret, "secret:test-id");
    expect(openRecipientEnvelope(privateKey, envelope, "secret:test-id")).toEqual(secret);
    expect(() => openRecipientEnvelope(privateKey, envelope, "secret:other-id")).toThrow();
  });

  it("round-trips database scalar types without losing bigints or dates", () => {
    const input = {
      at: new Date("2025-01-02T03:04:05.000Z"),
      amount: 1234567890123456789n,
      nested: [Buffer.from([0, 1, 255])],
    };
    expect(fromJsonValue(toJsonValue(input))).toEqual(input);
  });

  it("fingerprints objects independent of key insertion order", () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  });
});
