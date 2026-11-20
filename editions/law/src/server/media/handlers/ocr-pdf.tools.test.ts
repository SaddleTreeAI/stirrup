// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

/**
 * Real ocrmypdf smoke — runs only inside the media image with LAW_TOOLS=1.
 * Builds a one-page image-only PDF with the word "caffeine" drawn as pixels.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProcessRunner } from "../runner.js";
import { ocrArgs, ocrJobCount, splitSidecarSegments } from "./ocr-pdf.js";

const describeTools = process.env.LAW_TOOLS === "1" ? describe : describe.skip;

/** Tiny 5x7 glyphs for A–Z / space; renders DeviceGray image-only PDF (<40 lines). */
function imageOnlyPdf(word: string): Uint8Array {
  const glyphs: Record<string, number[]> = {
    " ": [0, 0, 0, 0, 0],
    C: [0x3e, 0x41, 0x41, 0x41, 0x22],
    A: [0x3e, 0x09, 0x09, 0x09, 0x3e],
    F: [0x7f, 0x09, 0x09, 0x09, 0x01],
    E: [0x7f, 0x49, 0x49, 0x49, 0x41],
    I: [0x41, 0x7f, 0x41],
    N: [0x7f, 0x04, 0x08, 0x10, 0x7f],
  };
  const scale = 4;
  const letters = word.toUpperCase().split("");
  const width = letters.reduce(
    (w, ch) => w + ((glyphs[ch] ?? glyphs[" "]!).length + 1) * scale,
    20,
  );
  const height = 7 * scale + 20;
  const pixels = Buffer.alloc(width * height, 255);
  let x = 10;
  for (const ch of letters) {
    const cols = glyphs[ch] ?? glyphs[" "]!;
    for (let col = 0; col < cols.length; col += 1) {
      for (let row = 0; row < 7; row += 1) {
        if ((cols[col]! >> row) & 1) {
          for (let dy = 0; dy < scale; dy += 1) {
            for (let dx = 0; dx < scale; dx += 1) {
              const px = x + col * scale + dx;
              const py = 10 + row * scale + dy;
              pixels[py * width + px] = 0;
            }
          }
        }
      }
    }
    x += (cols.length + 1) * scale;
  }
  const img = `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>stream\n`;
  const content = `q ${width} 0 0 ${height} 72 720 cm /Im0 Do Q`;
  const objects = [
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n",
    "2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n",
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /XObject<< /Im0 5 0 R >> >> >>endobj\n",
    `4 0 obj<< /Length ${content.length} >>stream\n${content}\nendstream\nendobj\n`,
    `5 0 obj${img}`,
  ];
  let body = Buffer.from("%PDF-1.4\n", "utf8");
  const offsets = [0];
  for (let i = 0; i < 4; i += 1) {
    offsets.push(body.length);
    body = Buffer.concat([body, Buffer.from(objects[i]!, "utf8")]);
  }
  offsets.push(body.length);
  body = Buffer.concat([
    body,
    Buffer.from(objects[4]!, "utf8"),
    pixels,
    Buffer.from("\nendstream\nendobj\n", "utf8"),
  ]);
  const xrefStart = body.length;
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i += 1) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  body = Buffer.concat([
    body,
    Buffer.from(
      `${xref}trailer<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
      "utf8",
    ),
  ]);
  return new Uint8Array(body);
}

describeTools("ocr-pdf real tools", () => {
  it("OCRs an image-only PDF and finds the known word in the sidecar", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ocr-tools-"));
    const pdfPath = path.join(dir, "scan.pdf");
    const outPath = path.join(dir, "out.pdf");
    const sidecar = path.join(dir, "out.txt");
    await writeFile(pdfPath, imageOnlyPdf("caffeine"));
    const runner = createProcessRunner();
    const started = Date.now();
    const result = await runner.run(
      "ocrmypdf",
      ocrArgs({
        langs: "eng",
        jobs: ocrJobCount(),
        sidecar,
        input: pdfPath,
        output: outPath,
      }),
      { cwd: dir, timeoutMs: 180_000 },
    );
    const elapsedMs = Date.now() - started;
    expect(result.code).toBe(0);
    const text = await readFile(sidecar, "utf8");
    expect(splitSidecarSegments(text).join(" ").toLowerCase()).toContain("caffeine");
    // Timing for the report (one page).
    expect(elapsedMs).toBeGreaterThan(0);
  }, 240_000);
});
