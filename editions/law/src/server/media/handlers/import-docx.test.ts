// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { HandlerContext, LawJobRow } from "../types.js";
import {
  assertSafeDocxZip,
  docxLooksEncrypted,
  extractDocxText,
  importDocxHandler,
  listZipCentralDirectory,
} from "./import-docx.js";

function job(overrides: Partial<LawJobRow> = {}): LawJobRow {
  const now = new Date();
  return {
    id: "job-1",
    caseId: "case-1",
    documentId: "doc-1",
    kind: "import_docx",
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    error: "",
    payload: {},
    runAfter: now,
    lockedAt: now,
    lockedBy: "w1",
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    ...overrides,
  };
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function documentXml(opts: { tracked?: boolean } = {}): string {
  const tracked = opts.tracked
    ? `<w:p><w:r><w:t>Final </w:t></w:r><w:del><w:r><w:delText>removed</w:delText></w:r></w:del><w:ins><w:r><w:t>kept</w:t></w:r></w:ins></w:p>`
    : `<w:p><w:r><w:t>Final kept</w:t></w:r></w:p>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Heading One</w:t></w:r></w:p>
    <w:p><w:r><w:t>Paragraph text.</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>List item</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    ${tracked}
  </w:body>
</w:document>`;
}

function buildDocx(opts: { tracked?: boolean } = {}): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(CONTENT_TYPES),
    "_rels/.rels": strToU8(RELS),
    "word/document.xml": strToU8(documentXml(opts)),
  });
}

/** Central-directory entry with a huge declared uncompressed size (zip bomb). */
function buildZipBomb(): Uint8Array {
  // Store a tiny payload but declare a huge uncompressed size in a hand-built CD.
  // Use a real zip then patch is fragile; instead build a minimal ZIP with one
  // stored entry whose uncompressed size field is inflated.
  const name = strToU8("word/document.xml");
  const data = strToU8("x");
  const local = new Uint8Array(30 + name.length + data.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(8, 0, true); // stored
  localView.setUint32(18, data.length, true);
  localView.setUint32(22, 0x0c800000, true); // claim ~200MB+ uncompressed
  localView.setUint16(26, name.length, true);
  local.set(name, 30);
  local.set(data, 30 + name.length);

  const central = new Uint8Array(46 + name.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(10, 0, true);
  centralView.setUint32(20, data.length, true);
  centralView.setUint32(24, 0x0c800000, true);
  centralView.setUint16(28, name.length, true);
  centralView.setUint32(42, 0, true);
  central.set(name, 46);

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, 1, true);
  eocdView.setUint16(10, 1, true);
  eocdView.setUint32(12, central.length, true);
  eocdView.setUint32(16, local.length, true);

  const out = new Uint8Array(local.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(eocd, local.length + central.length);
  return out;
}

function buildEncryptedLookingDocx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(CONTENT_TYPES),
    EncryptionInfo: strToU8("not-real"),
    EncryptedPackage: strToU8("cipher"),
  });
}

describe("docx zip guards", () => {
  it("lists central-directory entries without inflating", () => {
    const bytes = buildDocx();
    const entries = listZipCentralDirectory(bytes);
    expect(entries.map((e) => e.name).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
    ]);
  });

  it("rejects a zip bomb from directory sizes before extraction", () => {
    const entries = listZipCentralDirectory(buildZipBomb());
    expect(() => assertSafeDocxZip(entries)).toThrow(/Couldn't read this document/);
  });

  it("flags encrypted packages", () => {
    expect(docxLooksEncrypted(listZipCentralDirectory(buildEncryptedLookingDocx()))).toBe(true);
  });
});

describe("extractDocxText", () => {
  it("flattens headings, lists, and tables and notes tracked changes", async () => {
    const { text, trackedChanges } = await extractDocxText(buildDocx({ tracked: true }));
    expect(trackedChanges).toBe(true);
    expect(text).toContain("Heading One");
    expect(text).toContain("Paragraph text.");
    expect(text).toContain("List item");
    expect(text).toContain("Cell A");
    expect(text).toContain("Cell B");
    expect(text).toMatch(/kept/);
  });

  it("fails encrypted packages with a generic message", async () => {
    await expect(extractDocxText(buildEncryptedLookingDocx())).rejects.toThrow(
      /Couldn't read this document/,
    );
  });

  it("rejects zip bombs before inflate", async () => {
    await expect(extractDocxText(buildZipBomb())).rejects.toThrow(/Couldn't read this document/);
  });
});

describe("importDocxHandler", () => {
  it("seals extracted text and marks the document ready", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "import-docx-"));
    const original = path.join(tmpDir, "sample.docx");
    writeFileSync(original, buildDocx({ tracked: true }));

    const updates: unknown[] = [];
    const ctx: HandlerContext = {
      job: job(),
      prisma: {
        lawDocument: {
          findUnique: async () => ({ id: "doc-1", caseId: "case-1" }),
          update: async (args: { data: unknown }) => {
            updates.push(args.data);
            return {};
          },
        },
        lawCase: {
          findUnique: async () => ({ spaceId: "space-1" }),
        },
      } as never,
      runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
      tmpDir,
      readOriginal: async () => original,
      saveArtifact: async () => ({ id: "art" }),
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };

    await importDocxHandler(ctx);
    expect(updates).toEqual([
      expect.objectContaining({
        status: "ready",
        statusDetail: "Word document: no page numbers (tracked changes present)",
        body: expect.stringContaining("Heading One"),
      }),
    ]);
    const body = (updates[0] as { body: string }).body;
    expect(body).toContain("Cell A");
    expect(body).toMatch(/kept/);
  });

  it("rejects oversize files before reading as docx", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "import-docx-cap-"));
    const original = path.join(tmpDir, "huge.docx");
    writeFileSync(original, Buffer.alloc(1024, 1));
    const prev = process.env.LAW_DOCX_MAX_MB;
    process.env.LAW_DOCX_MAX_MB = "0.0001"; // ~100 bytes

    const updates: unknown[] = [];
    try {
      await expect(
        importDocxHandler({
          job: job(),
          prisma: {
            lawDocument: {
              findUnique: async () => ({ id: "doc-1", caseId: "case-1" }),
              update: async (args: { data: unknown }) => {
                updates.push(args.data);
                return {};
              },
            },
            lawCase: {
              findUnique: async () => ({ spaceId: "space-1" }),
            },
          } as never,
          runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
          tmpDir,
          readOriginal: async () => original,
          saveArtifact: async () => ({ id: "art" }),
          log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        }),
      ).rejects.toThrow(/File too large/);
      expect(updates).toEqual([
        expect.objectContaining({ status: "failed", statusDetail: "File too large" }),
      ]);
    } finally {
      if (prev === undefined) delete process.env.LAW_DOCX_MAX_MB;
      else process.env.LAW_DOCX_MAX_MB = prev;
    }
  });
});
