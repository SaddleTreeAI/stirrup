// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import {
  ContentDecryptionError,
  ciphertextKeyId,
  contentEncryptionOf,
  decryptText,
  encryptText,
  isCiphertext,
} from "@rakazo/db";

/**
 * Law text columns sealed with the space data key from
 * `contentEncryptionOf(prisma).ring` (same envelope as core content).
 * Titles, filenames, ids, timestamps and statuses stay plaintext.
 */
export type LawSealTable =
  | "law_cases"
  | "law_documents"
  | "law_document_pages"
  | "law_transcript_segments"
  | "law_media_frames";

export type LawSealLocation = {
  table: LawSealTable;
  column: string;
  rowId: string;
  spaceId: string;
  /**
   * Bound into the ciphertext AAD with the row id.
   * Cases: spaceId. Documents: caseId. Pages / segments / frames: documentId.
   */
  owner: string;
};

/** Columns the backfill walks. */
export const LAW_SEALED_COLUMNS: ReadonlyArray<{
  table: LawSealTable;
  column: string;
  owner: "space" | "case" | "document";
}> = [
  { table: "law_cases", column: "brief", owner: "space" },
  { table: "law_documents", column: "body", owner: "case" },
  { table: "law_document_pages", column: "text", owner: "document" },
  { table: "law_transcript_segments", column: "text", owner: "document" },
  { table: "law_media_frames", column: "caption", owner: "document" },
];

/**
 * Seal plaintext for storage. With CONTENT_ENCRYPTION off (or no encrypting
 * client), stores plaintext; a value that already looks like ciphertext gets a
 * zero-width prefix so a later read does not treat it as sealed (same as core).
 */
export async function sealLawText(
  prisma: unknown,
  location: LawSealLocation,
  plaintext: string,
): Promise<string> {
  const encryption = contentEncryptionOf(prisma);
  if (!encryption?.ring.encryptWrites) {
    return isCiphertext(plaintext) ? `\u200b${plaintext}` : plaintext;
  }
  const key = await encryption.ring.current(location.spaceId);
  return encryptText(key, contentLocation(location), plaintext);
}

/**
 * Open a stored value. Plaintext (including pre-migration rows) passes through;
 * ciphertext always decrypts when keys are available.
 */
export async function openLawText(
  prisma: unknown,
  location: LawSealLocation,
  value: string,
): Promise<string> {
  if (!isCiphertext(value)) return value;
  const encryption = contentEncryptionOf(prisma);
  if (!encryption) throw new ContentDecryptionError();
  const keyId = ciphertextKeyId(value);
  if (!keyId) throw new ContentDecryptionError();
  const key = await encryption.ring.byId(keyId);
  if (key.spaceId !== location.spaceId) {
    throw new ContentDecryptionError("Encrypted content belongs to another space");
  }
  return decryptText(key, contentLocation(location), value);
}

function contentLocation(location: LawSealLocation) {
  return {
    table: location.table,
    column: location.column,
    rowId: location.rowId,
    owner: location.owner,
  };
}
