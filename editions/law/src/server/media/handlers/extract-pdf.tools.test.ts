// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

/**
 * Real pdftotext/pdfinfo smoke — runs only inside the media image with LAW_TOOLS=1.
 * Generates a tiny synthetic PDF with raw bytes (no npm PDF dependency).
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProcessRunner } from "../runner.js";
import { parsePdfInfo } from "./extract-pdf.js";

const describeTools = process.env.LAW_TOOLS === "1" ? describe : describe.skip;

/** Minimal one-page PDF with the word "caffeine" in a content stream. */
function tinyPdf(): Uint8Array {
  const content = "BT /F1 12 Tf 100 700 Td (caffeine page one) Tj ET";
  const objects = [
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n",
    "2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n",
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n",
    `4 0 obj<< /Length ${content.length} >>stream\n${content}\nendstream\nendobj\n`,
    "5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += object;
  }
  const xrefStart = Buffer.byteLength(body, "utf8");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += xref;
  body += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

describeTools("extract-pdf real tools", () => {
  it("reads page count and text from a tiny generated PDF", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pdf-tools-"));
    const pdfPath = path.join(dir, "tiny.pdf");
    const outPath = path.join(dir, "out.txt");
    await writeFile(pdfPath, tinyPdf());
    const runner = createProcessRunner();
    const info = await runner.run("pdfinfo", [pdfPath], { cwd: dir, timeoutMs: 30_000 });
    expect(info.code).toBe(0);
    const parsed = parsePdfInfo(info.stdout);
    expect(parsed?.pages).toBe(1);
    expect(parsed?.encrypted).toBe(false);
    const text = await runner.run("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, outPath], {
      cwd: dir,
      timeoutMs: 30_000,
    });
    expect(text.code).toBe(0);
    const { readFile } = await import("node:fs/promises");
    const extracted = await readFile(outPath, "utf8");
    expect(extracted.toLowerCase()).toContain("caffeine");
  });
});
