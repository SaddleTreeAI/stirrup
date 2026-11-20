// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { describe, expect, it } from "vitest";
import { classify, enqueueExtraction, prepareIngestBody } from "./ingest.js";

describe("classify", () => {
  it.each([
    ["text/plain", "notes.txt", "text", true],
    ["text/markdown", "brief.md", "text", true],
    ["text/csv", "sheet.csv", "text", true],
    ["application/json", "data.json", "text", true],
    ["text/html", "page.html", "text", true],
    ["application/xhtml+xml", "page.htm", "text", true],
    ["application/rtf", "memo.rtf", "other", false],
    ["text/rtf", "memo.rtf", "other", false],
    ["application/pdf", "complaint.pdf", "pdf", false],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "motion.docx",
      "docx",
      false,
    ],
    ["audio/mpeg", "interview.mp3", "audio", false],
    ["audio/ogg", "clip.opus", "audio", false],
    ["application/octet-stream", "clip.wma", "audio", false],
    ["audio/flac", "tape.flac", "audio", false],
    ["video/mp4", "hearing.mp4", "video", false],
    ["video/x-msvideo", "old.avi", "video", false],
    ["application/octet-stream", "clip.m4v", "video", false],
    ["image/png", "scan.png", "image", false],
    ["application/octet-stream", "unknown.bin", "other", false],
  ] as const)("%s / %s → %s textual=%s", (mime, filename, kind, textual) => {
    expect(classify(mime, filename)).toEqual({ kind, textual });
  });
});

describe("prepareIngestBody", () => {
  it("strips a UTF-8 BOM from textual content", () => {
    const bytes = new TextEncoder().encode("\uFEFFhello");
    const result = prepareIngestBody(classify("text/plain", "a.txt"), bytes, "text/plain", "a.txt");
    expect(result).toEqual({ body: "hello", status: "ready", statusDetail: "" });
  });

  it("caps textual bodies at two million characters", () => {
    const text = "x".repeat(2_000_001);
    const bytes = new TextEncoder().encode(text);
    const result = prepareIngestBody(classify("text/plain", "a.txt"), bytes, "text/plain", "a.txt");
    expect(result.body).toHaveLength(2_000_000);
    expect(result.statusDetail).toBe("Truncated to 2000000 characters.");
  });

  it("strips HTML tags for html uploads", () => {
    const bytes = new TextEncoder().encode(
      "<p>Hello <b>world</b></p><script>hide()</script\t\n bar><style>x{}</style >",
    );
    const result = prepareIngestBody(classify("text/html", "a.html"), bytes, "text/html", "a.html");
    expect(result.body).toBe("Hello world");
  });

  it("leaves a placeholder for non-textual kinds", () => {
    const result = prepareIngestBody(
      classify("application/pdf", "a.pdf"),
      new Uint8Array([1, 2, 3]),
      "application/pdf",
      "a.pdf",
    );
    expect(result).toEqual({
      body: "",
      status: "ready",
      statusDetail: "Stored. Text extraction not available for this file type yet.",
    });
  });

  it("queues audio and video for transcription", () => {
    expect(
      prepareIngestBody(
        classify("audio/mpeg", "a.mp3"),
        new Uint8Array([1]),
        "audio/mpeg",
        "a.mp3",
      ),
    ).toEqual({ body: "", status: "queued", statusDetail: "Waiting to transcribe" });
    expect(
      prepareIngestBody(classify("video/mp4", "a.mp4"), new Uint8Array([1]), "video/mp4", "a.mp4"),
    ).toEqual({ body: "", status: "queued", statusDetail: "Waiting to transcribe" });
  });
});

describe("enqueueExtraction", () => {
  it("returns null for text kinds", async () => {
    await expect(
      enqueueExtraction({} as never, { id: "doc-1", caseId: "case-1", kind: "text" }),
    ).resolves.toBeNull();
  });

  it("classifies from the stored document when kind is omitted", async () => {
    const prisma = {
      lawDocument: {
        findUnique: async () => ({ mimeType: "text/plain", filename: "a.txt" }),
      },
    };
    await expect(
      enqueueExtraction(prisma as never, { id: "doc-1", caseId: "case-1" }),
    ).resolves.toBeNull();
  });

  it("enqueues a media job for pdf", async () => {
    const calls: unknown[] = [];
    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          lawJob: {
            findFirst: async () => null,
            create: async (args: { data: unknown }) => {
              calls.push(args.data);
              return { id: "job-1" };
            },
          },
        }),
    };
    await expect(
      enqueueExtraction(prisma as never, { id: "doc-1", caseId: "case-1", kind: "pdf" }),
    ).resolves.toEqual({ id: "job-1", created: true });
    expect(calls).toEqual([
      expect.objectContaining({
        caseId: "case-1",
        documentId: "doc-1",
        kind: "extract_pdf",
        status: "queued",
      }),
    ]);
  });

  it("enqueues a transcribe job for audio", async () => {
    const calls: unknown[] = [];
    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          lawJob: {
            findFirst: async () => null,
            create: async (args: { data: unknown }) => {
              calls.push(args.data);
              return { id: "job-2" };
            },
          },
        }),
    };
    await expect(
      enqueueExtraction(prisma as never, { id: "doc-2", caseId: "case-1", kind: "audio" }),
    ).resolves.toEqual({ id: "job-2", created: true });
    expect(calls).toEqual([
      expect.objectContaining({
        documentId: "doc-2",
        kind: "transcribe",
        status: "queued",
      }),
    ]);
  });
});
