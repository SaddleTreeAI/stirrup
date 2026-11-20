// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import { beforeEach, describe, expect, it, vi } from "vitest";
import { lawCaseTools } from "./case-library-tools.js";

vi.mock("./search.js", () => ({
  searchCaseLibrary: vi.fn(),
}));

vi.mock("./library-upload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./library-upload.js")>();
  return {
    ...actual,
    uploadLibraryDocument: vi.fn(),
  };
});

vi.mock("./seal.js", () => ({
  openLawText: vi.fn(async (_p: unknown, _m: unknown, text: string) => text),
  sealLawText: vi.fn(async (_p: unknown, _m: unknown, text: string) => text),
}));

import { uploadLibraryDocument } from "./library-upload.js";
import { searchCaseLibrary } from "./search.js";

const actor = { userId: "user-1", spaceId: "space-1" };

const unusedRun = {
  maxBytes: 1024,
  readComputerFile: vi.fn(),
  storeFile: vi.fn(),
};

describe("lawCaseTools", () => {
  beforeEach(() => {
    vi.mocked(searchCaseLibrary).mockReset();
    vi.mocked(uploadLibraryDocument).mockReset();
  });

  it("returns undefined for ordinary bots", async () => {
    const prisma = {
      lawCaseBot: { findUnique: vi.fn(async () => null) },
      lawCase: { findUnique: vi.fn() },
    };
    await expect(lawCaseTools(prisma as never, "plain", actor)).resolves.toBeUndefined();
  });

  it("searches uploads and notes and reads a PDF page or a text note", async () => {
    const prisma = {
      lawCaseBot: { findUnique: vi.fn(async () => ({ caseId: "case-1" })) },
      lawCase: {
        findUnique: vi.fn(async () => ({
          id: "case-1",
          spaceId: "space-1",
          deletedAt: null,
        })),
      },
      lawDocument: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
          if (where.id === "pdf-1") {
            return {
              id: "pdf-1",
              title: "Police report",
              filename: "report.pdf",
              body: "merged pages",
              mimeType: "application/pdf",
              status: "ready",
              pageCount: 15,
            };
          }
          if (where.id === "note-1") {
            return {
              id: "note-1",
              title: "Witness notes",
              filename: "witness.txt",
              body: "Saw the car leave at noon.",
              mimeType: "text/plain",
              status: "ready",
              pageCount: null,
            };
          }
          return null;
        }),
        findMany: vi.fn(),
      },
      lawDocumentPage: {
        findFirst: vi.fn(async () => ({
          id: "page-2",
          page: 2,
          text: "Arrest narrative on page two.",
          ocr: false,
        })),
        findMany: vi.fn(async ({ where }: { where: { documentId: string } }) => {
          if (where.documentId === "pdf-1") return [{ page: 1 }, { page: 2 }];
          return [];
        }),
      },
      lawTranscriptSegment: { findMany: vi.fn(async () => []) },
    };

    vi.mocked(searchCaseLibrary).mockResolvedValue({
      hits: [
        {
          kind: "page",
          documentId: "pdf-1",
          title: "Police report",
          page: 2,
          snippet: "Arrest narrative",
          matches: [],
          score: 10,
        },
        {
          kind: "text",
          documentId: "note-1",
          title: "Witness notes",
          snippet: "Saw the car leave",
          matches: [],
          score: 8,
        },
      ],
      truncated: false,
      nextCursor: null,
      scanned: 2,
      durationMs: 1,
    });

    const tools = await lawCaseTools(prisma as never, "bot-1", actor);
    expect(tools?.map((tool) => tool.name)).toEqual([
      "search_case_library",
      "read_case_document",
      "save_to_case_library",
    ]);

    const search = tools?.find((tool) => tool.name === "search_case_library");
    const read = tools?.find((tool) => tool.name === "read_case_document");
    const save = tools?.find((tool) => tool.name === "save_to_case_library");
    expect(search?.readOnly).toBe(true);
    expect(read?.readOnly).toBe(true);
    expect(save?.readOnly).toBeUndefined();

    const searchResult = (await search!.execute({ query: "arrest" }, unusedRun)) as {
      hits: Array<{ documentId: string; kind: string }>;
    };
    expect(searchCaseLibrary).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ userId: "user-1", spaceId: "space-1" }),
      expect.objectContaining({ caseId: "case-1", query: "arrest" }),
    );
    expect(searchResult.hits.map((hit) => hit.documentId)).toEqual(["pdf-1", "note-1"]);

    const page = (await read!.execute({ documentId: "pdf-1", page: 2 }, unusedRun)) as {
      text: string;
      page: number;
    };
    expect(page).toMatchObject({
      documentId: "pdf-1",
      page: 2,
      text: "Arrest narrative on page two.",
    });

    const note = (await read!.execute({ documentId: "note-1" }, unusedRun)) as { text: string };
    expect(note.text).toContain("Saw the car leave at noon.");
    expect(note).toMatchObject({
      documentId: "note-1",
      filename: "witness.txt",
    });
  });

  it("saves a computer file into the case library as an upload", async () => {
    const prisma = {
      lawCaseBot: { findUnique: vi.fn(async () => ({ caseId: "case-1" })) },
      lawCase: {
        findUnique: vi.fn(async () => ({
          id: "case-1",
          spaceId: "space-1",
          deletedAt: null,
        })),
      },
    };
    const bytes = new TextEncoder().encode("PK fake docx");
    const run = {
      maxBytes: 1024 * 1024,
      readComputerFile: vi.fn(async () => bytes),
      storeFile: vi.fn(async () => ({
        artifactId: "artifact-1",
        sizeBytes: bytes.byteLength,
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      })),
    };
    vi.mocked(uploadLibraryDocument).mockResolvedValue({
      id: "doc-1",
      caseId: "case-1",
      title: "Motion to Suppress",
      filename: "motion.docx",
      kind: "upload",
      status: "queued",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: bytes.byteLength,
      artifactId: "artifact-1",
      body: "",
    } as Awaited<ReturnType<typeof uploadLibraryDocument>>);

    const tools = await lawCaseTools(prisma as never, "bot-1", actor);
    const save = tools?.find((tool) => tool.name === "save_to_case_library");
    const result = await save!.execute(
      { path: "drafts/motion.docx", title: "Motion to Suppress" },
      run,
    );

    expect(run.readComputerFile).toHaveBeenCalledWith("drafts/motion.docx");
    expect(uploadLibraryDocument).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ store: expect.any(Function) }),
      expect.objectContaining({ userId: "user-1", spaceId: "space-1" }),
      expect.objectContaining({
        caseId: "case-1",
        filename: "motion.docx",
        titleOverride: "Motion to Suppress",
        bytes,
      }),
    );
    expect(result).toEqual({
      documentId: "doc-1",
      title: "Motion to Suppress",
      filename: "motion.docx",
      status: "queued",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: bytes.byteLength,
    });
  });
});
