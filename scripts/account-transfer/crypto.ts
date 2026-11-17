import type { KeyObject } from "node:crypto";
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";

export type RecipientEnvelope = {
  version: 1;
  wrappedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

/** Hybrid RSA-OAEP + AES-GCM envelope; context is authenticated but not encrypted. */
export function sealForRecipient(
  publicKey: string | Buffer | KeyObject,
  plaintext: Uint8Array,
  context: string,
): RecipientEnvelope {
  const contentKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contentKey, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    wrappedKey: publicEncrypt(
      { key: publicKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING },
      contentKey,
    ).toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

export function openRecipientEnvelope(
  privateKey: string | Buffer | KeyObject,
  envelope: RecipientEnvelope,
  context: string,
): Buffer {
  if (envelope.version !== 1) throw new Error("Unsupported recipient envelope version");
  const contentKey = privateDecrypt(
    { key: privateKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(envelope.wrappedKey, "base64url"),
  );
  if (contentKey.length !== 32) throw new Error("Invalid recipient envelope key");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    contentKey,
    Buffer.from(envelope.iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);
}

export function toJsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (value instanceof Date) return { $type: "date", value: value.toISOString() };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return { $type: "bytes", value: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, toJsonValue(child)]),
    );
  return value;
}

export function fromJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromJsonValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.$type === "bigint" && typeof record.value === "string") return BigInt(record.value);
    if (record.$type === "date" && typeof record.value === "string") return new Date(record.value);
    if (record.$type === "bytes" && typeof record.value === "string")
      return Buffer.from(record.value, "base64");
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [key, fromJsonValue(child)]),
    );
  }
  return value;
}
