// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, drainUnscopedDatabaseAccess, runAsTenant } from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountLawRoutes } from "./routes.js";

// The API connects as the runtime login. These rows are visible only after the
// route sets the space, the same way a deployment enforces row-level security.
const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("law cases under row-level security", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `law-cases-user-${suffix}`;
  const otherUserId = `law-cases-other-${suffix}`;
  const organizationId = `law-cases-org-${suffix}`;
  const spaceId = `law-cases-space-${suffix}`;
  const otherSpaceId = `law-cases-space-b-${suffix}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  const otherActor: Actor = {
    userId: otherUserId,
    spaceId: otherSpaceId,
    email: `${otherUserId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: (() => Promise<void>) | undefined;
  let app: Hono;
  const caseIds: string[] = [];
  let otherCaseId = "";
  let otherDocId = "";

  beforeAll(async () => {
    const db = createDb(runtimeUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await system.user.create({
      data: { id: userId, name: userId, email: actor.email, emailVerified: false },
    });
    await system.user.create({
      data: {
        id: otherUserId,
        name: otherUserId,
        email: otherActor.email,
        emailVerified: false,
      },
    });
    await system.organization.create({
      data: { id: organizationId, name: "Law Org", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
    await system.space.create({
      data: { id: otherSpaceId, organizationId, name: "Other", isDefault: false },
    });
    const names = ["Ruiz", "Ward", "Nunez"] as const;
    for (const [position, name] of names.entries()) {
      const created = await system.lawCase.create({
        data: {
          spaceId,
          slug: name.toLowerCase(),
          name,
          brief: `${name} brief`,
          position,
          createdBy: userId,
        },
      });
      caseIds.push(created.id);
      await system.lawCaseMember.create({ data: { caseId: created.id, userId } });
      const bot = await system.bot.create({
        data: { spaceId, userId, name: "Case Manager", color: "blue" },
      });
      await system.lawCaseBot.create({
        data: { caseId: created.id, role: "manager", botId: bot.id },
      });
      if (position === 0) {
        await system.lawDocument.create({
          data: {
            caseId: created.id,
            title: "Complaint",
            filename: "complaint.pdf",
            body: "SYNTHETIC complaint",
            kind: "library",
            version: 1,
          },
        });
      }
    }
    const otherCase = await system.lawCase.create({
      data: {
        spaceId: otherSpaceId,
        slug: "other",
        name: "Other Case",
        brief: "Other brief",
        position: 0,
      },
    });
    otherCaseId = otherCase.id;
    await system.lawCaseMember.create({
      data: { caseId: otherCase.id, userId: otherUserId },
    });
    const otherDoc = await system.lawDocument.create({
      data: {
        caseId: otherCase.id,
        title: "Secret",
        filename: "secret.txt",
        body: "SYNTHETIC secret from case B",
        kind: "library",
        version: 1,
      },
    });
    otherDocId = otherDoc.id;

    app = new Hono();
    mountLawRoutes(app, {
      prisma,
      sessionActor: async (request) => (request.headers.get("authorization") ? actor : null),
    });
  });

  afterAll(async () => {
    if (system) {
      await system.organization.deleteMany({ where: { id: organizationId } });
      await system.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    }
    await close?.();
  });

  it("returns the three cases for the runtime login once the space is set", async () => {
    const hidden = await prisma.lawCaseMember.count({ where: { userId } });
    expect(hidden).toBe(0);
    expect(drainUnscopedDatabaseAccess().join("\n")).toContain("LawCaseMember.count");

    const denied = await app.request("/api/law/cases");
    expect(denied.status).toBe(401);

    const response = await app.request("/api/law/cases", {
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      cases: Array<{ name: string; bots: Array<{ role: string; name: string; botId: string }> }>;
    };
    expect(body.cases.map((item) => item.name)).toEqual(["Ruiz", "Ward", "Nunez"]);
    expect(body.cases[0]?.bots).toEqual([
      { role: "manager", name: "Case Manager", botId: expect.any(String) },
    ]);

    const documents = await app.request(`/api/law/cases/${caseIds[0]}/documents`, {
      headers: { authorization: "Bearer test" },
    });
    expect(documents.status).toBe(200);
    await expect(documents.json()).resolves.toMatchObject({
      documents: [{ title: "Complaint", kind: "library", filename: "complaint.pdf", version: 1 }],
    });

    const review = await system.lawDocument.create({
      data: {
        caseId: caseIds[0]!,
        title: "Motion draft",
        filename: "motion-draft.md",
        body: "SYNTHETIC DRAFT — NOT FOR FILING\nFirst version",
        kind: "review",
        version: 1,
      },
    });
    const versioned = await app.request(
      `/api/law/cases/${caseIds[0]}/documents/${review.id}/versions`,
      {
        method: "POST",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({ body: "SYNTHETIC DRAFT — NOT FOR FILING\nSecond version" }),
      },
    );
    expect(versioned.status).toBe(201);
    await expect(versioned.json()).resolves.toMatchObject({
      document: {
        title: "Motion draft",
        filename: "motion-draft.md",
        version: 2,
        body: "SYNTHETIC DRAFT — NOT FOR FILING\nSecond version",
      },
    });

    const bot = await system.bot.create({
      data: { spaceId, userId, name: "Custom", color: "green" },
    });
    const attached = await app.request(`/api/law/cases/${caseIds[0]}/bots`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ botId: bot.id }),
    });
    expect(attached.status).toBe(200);
    await expect(attached.json()).resolves.toMatchObject({
      botId: bot.id,
      role: `custom:${bot.id}`,
    });
  });

  it("hides case B documents from case A's tenant", async () => {
    const visibleToOwner = await runAsTenant(otherActor, () =>
      prisma.lawDocument.findMany({ where: { caseId: otherCaseId } }),
    );
    expect(visibleToOwner.map((doc) => doc.id)).toEqual([otherDocId]);

    const hiddenFromA = await runAsTenant(actor, () =>
      prisma.lawDocument.findMany({ where: { caseId: otherCaseId } }),
    );
    expect(hiddenFromA).toEqual([]);

    const outsiderDocs = await app.request(`/api/law/cases/${otherCaseId}/documents`, {
      headers: { authorization: "Bearer test" },
    });
    expect(outsiderDocs.status).toBe(404);
  });

  it("excludes soft-deleted rows from the documents list", async () => {
    const caseId = caseIds[0]!;
    const doomed = await system.lawDocument.create({
      data: {
        caseId,
        title: "To delete",
        filename: "to-delete.txt",
        body: "SYNTHETIC doomed",
        kind: "library",
        version: 1,
      },
    });
    await system.lawDocument.update({
      where: { id: doomed.id },
      data: { deletedAt: new Date() },
    });
    const response = await app.request(`/api/law/cases/${caseId}/documents`, {
      headers: { authorization: "Bearer test" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { documents: Array<{ id: string }> };
    expect(body.documents.map((doc) => doc.id)).not.toContain(doomed.id);
  });

  it("stores document bodies as ciphertext and reads them back plain", async () => {
    const caseId = caseIds[0]!;
    const created = await app.request(`/api/law/cases/${caseId}/documents`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ title: "Sealed note", body: "SYNTHETIC sealed body" }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { document: { id: string; body: string } };
    expect(createdBody.document.body).toBe("SYNTHETIC sealed body");

    const stored = await system.lawDocument.findUnique({
      where: { id: createdBody.document.id },
      select: { body: true },
    });
    expect(stored?.body.startsWith("rkz1:")).toBe(true);
    expect(stored?.body).not.toContain("SYNTHETIC sealed body");

    const listed = await app.request(`/api/law/cases/${caseId}/documents`, {
      headers: { authorization: "Bearer test" },
    });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { documents: Array<{ id: string; body: string }> };
    const again = listBody.documents.find((doc) => doc.id === createdBody.document.id);
    expect(again?.body).toBe("SYNTHETIC sealed body");

    // Legacy plaintext row: backfill seals it (migrateLawText).
    const legacy = await system.lawDocument.create({
      data: {
        caseId,
        title: "Legacy plain",
        filename: "legacy.txt",
        body: "SYNTHETIC legacy plaintext",
        kind: "library",
        version: 1,
      },
    });
    expect(legacy.body.startsWith("rkz1:")).toBe(false);
    const { migrateLawText } = await import("./cli/encrypt.js");
    const progress = await migrateLawText(system, {
      mode: "backfill",
      caseId,
    });
    const docs = progress.find((row) => row.table === "law_documents");
    expect(docs?.updated).toBeGreaterThanOrEqual(1);
    const after = await system.lawDocument.findUnique({
      where: { id: legacy.id },
      select: { body: true },
    });
    expect(after?.body.startsWith("rkz1:")).toBe(true);
  });

  it("soft-deletes a case, hides it from the list, then restores it", async () => {
    const caseId = caseIds[1]!;
    const deleted = await app.request(`/api/law/cases/${caseId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });
    expect(deleted.status).toBe(200);
    const deletedBody = (await deleted.json()) as { id: string; purgeAfter: string | null };
    expect(deletedBody.id).toBe(caseId);
    expect(deletedBody.purgeAfter).toEqual(expect.any(String));

    const listed = await app.request("/api/law/cases", {
      headers: { authorization: "Bearer test" },
    });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as {
      cases: Array<{ id: string }>;
      deletedBotIds: string[];
    };
    expect(listBody.cases.map((item) => item.id)).not.toContain(caseId);
    expect(listBody.deletedBotIds.length).toBeGreaterThan(0);

    const docs = await app.request(`/api/law/cases/${caseId}/documents`, {
      headers: { authorization: "Bearer test" },
    });
    expect(docs.status).toBe(404);

    const restored = await app.request(`/api/law/cases/${caseId}/restore`, {
      method: "POST",
      headers: { authorization: "Bearer test" },
    });
    expect(restored.status).toBe(200);
    const again = await app.request("/api/law/cases", {
      headers: { authorization: "Bearer test" },
    });
    const againBody = (await again.json()) as { cases: Array<{ id: string }> };
    expect(againBody.cases.map((item) => item.id)).toContain(caseId);
  });

  it("lists pageCount and pages for an uploaded PDF after extraction", async () => {
    const caseId = caseIds[0]!;
    // Minimal synthetic PDF header bytes — extraction is faked below (no media worker).
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 synthetic three-page fixture");
    const files = {
      maxBytes: 1024 * 1024,
      store: async () => ({
        artifactId: `artifact-pdf-${suffix}`,
        sizeBytes: pdfBytes.byteLength,
        mediaType: "application/pdf",
      }),
      open: async () => ({
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(pdfBytes);
            controller.close();
          },
        }),
        size: pdfBytes.byteLength,
        mediaType: "application/pdf",
      }),
    };
    const uploadApp = new Hono();
    mountLawRoutes(uploadApp, {
      prisma,
      sessionActor: async (request) => (request.headers.get("authorization") ? actor : null),
      files,
    });

    const form = new FormData();
    form.set("file", new File([pdfBytes], "synthetic.pdf", { type: "application/pdf" }));
    const uploaded = await uploadApp.request(`/api/law/cases/${caseId}/documents/upload`, {
      method: "POST",
      headers: { authorization: "Bearer test" },
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const uploadedBody = (await uploaded.json()) as {
      document: { id: string; status: string; pageCount: number | null };
    };
    expect(uploadedBody.document.status).toBe("queued");
    const docId = uploadedBody.document.id;

    // Fake extractor: write three sealed-or-plain pages and mark ready.
    await system.lawDocumentPage.createMany({
      data: [
        { documentId: docId, page: 1, text: "SYNTHETIC page one", ocr: false },
        { documentId: docId, page: 2, text: "SYNTHETIC page two caffeine", ocr: false },
        { documentId: docId, page: 3, text: "SYNTHETIC page three", ocr: false },
      ],
    });
    await system.lawDocument.update({
      where: { id: docId },
      data: {
        pageCount: 3,
        status: "ready",
        statusDetail: "",
        body: "\n\n[page 1]\n\nSYNTHETIC page one\n\n[page 2]\n\nSYNTHETIC page two caffeine\n\n[page 3]\n\nSYNTHETIC page three",
      },
    });

    const listed = await uploadApp.request(`/api/law/cases/${caseId}/documents`, {
      headers: { authorization: "Bearer test" },
    });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as {
      documents: Array<{ id: string; pageCount: number | null }>;
    };
    expect(listBody.documents.find((doc) => doc.id === docId)?.pageCount).toBe(3);

    const pages = await uploadApp.request(
      `/api/law/cases/${caseId}/documents/${docId}/pages?from=1&to=3`,
      { headers: { authorization: "Bearer test" } },
    );
    expect(pages.status).toBe(200);
    const pagesBody = (await pages.json()) as { pages: Array<{ page: number; text: string }> };
    expect(pagesBody.pages).toHaveLength(3);
    expect(pagesBody.pages[1]?.text).toContain("page two");

    const deleted = await uploadApp.request(`/api/law/cases/${caseId}/documents/${docId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test" },
    });
    expect(deleted.status).toBe(204);
    const remaining = await system.lawDocumentPage.count({ where: { documentId: docId } });
    expect(remaining).toBe(0);
  });

  it("renames every version in a document family", async () => {
    const caseId = caseIds[0]!;
    const root = await system.lawDocument.create({
      data: {
        caseId,
        title: "Original",
        filename: "original.md",
        body: "SYNTHETIC v1",
        kind: "review",
        version: 1,
      },
    });
    const child = await system.lawDocument.create({
      data: {
        caseId,
        title: "Original",
        filename: "original.md",
        body: "SYNTHETIC v2",
        kind: "review",
        version: 2,
        rootId: root.id,
      },
    });
    const renamed = await app.request(`/api/law/cases/${caseId}/documents/${child.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed family" }),
    });
    expect(renamed.status).toBe(200);
    const rows = await system.lawDocument.findMany({
      where: { id: { in: [root.id, child.id] } },
      select: { id: true, title: true, filename: true },
      orderBy: { version: "asc" },
    });
    expect(rows).toEqual([
      { id: root.id, title: "Renamed family", filename: "renamed-family.md" },
      { id: child.id, title: "Renamed family", filename: "renamed-family.md" },
    ]);
  });

  it("inserts transcript segments through the transcribe handler and reads a window", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { createTranscribeHandler } = await import("./media/handlers/transcribe.js");

    const caseId = caseIds[0]!;
    const doc = await system.lawDocument.create({
      data: {
        caseId,
        title: "Hearing audio",
        filename: "hearing.mp3",
        body: "",
        kind: "upload",
        source: "upload",
        mimeType: "audio/mpeg",
        status: "queued",
        statusDetail: "Waiting to transcribe",
        version: 1,
      },
    });

    const tmpDir = mkdtempSync(path.join(tmpdir(), "v1-pg-"));
    const modelsDir = path.join(tmpDir, "models", "small");
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(path.join(modelsDir, "model.bin"), "x");
    const original = path.join(tmpDir, "hearing.mp3");
    writeFileSync(original, "fake-audio");

    const jsonl = [
      JSON.stringify({ start: 0.0, end: 1.0, text: "Alpha" }),
      JSON.stringify({ start: 5.0, end: 6.5, text: "Bravo" }),
      JSON.stringify({ start: 10.0, end: 11.0, text: "Charlie" }),
      JSON.stringify({ done: true, language: "en", duration: 12 }),
    ].join("\n");

    const handler = createTranscribeHandler({
      env: {
        LAW_MODELS_DIR: path.join(tmpDir, "models"),
        LAW_ASR_MODEL: "small",
        LAW_ASR_DEVICE: "cpu",
      },
      resolveConfig: (env) => ({
        engine: "faster-whisper",
        model: "small",
        modelDir: path.join(env.LAW_MODELS_DIR!, "small"),
        device: "cpu",
        computeType: "int8",
        language: "auto",
        modelsRoot: env.LAW_MODELS_DIR!,
        scriptPath: "/tmp/asr.py",
        maxMinutes: 360,
      }),
    });

    await handler({
      job: {
        id: "job-pg-1",
        caseId,
        documentId: doc.id,
        kind: "transcribe",
        status: "running",
        attempts: 1,
        maxAttempts: 3,
        error: "",
        payload: {},
        runAfter: new Date(),
        lockedAt: new Date(),
        lockedBy: "test",
        createdAt: new Date(),
        updatedAt: new Date(),
        finishedAt: null,
      },
      prisma: system,
      runner: {
        async run(cmd, args) {
          if (cmd === "ffprobe") {
            return {
              code: 0,
              stdout: JSON.stringify({
                format: { duration: "12" },
                streams: [{ codec_type: "audio", duration: "12" }],
              }),
              stderr: "",
            };
          }
          if (cmd === "nvidia-smi") return { code: 127, stdout: "", stderr: "" };
          if (cmd === "ffmpeg") {
            writeFileSync(path.join(tmpDir, "audio.wav"), "wav");
            return { code: 0, stdout: "", stderr: "" };
          }
          if (cmd === "python3") {
            const outIdx = args.indexOf("--out");
            writeFileSync(args[outIdx + 1]!, jsonl);
            return { code: 0, stdout: "progress 100\n", stderr: "" };
          }
          return { code: 127, stdout: "", stderr: "unknown" };
        },
      },
      tmpDir,
      readOriginal: async () => original,
      saveArtifact: async () => ({ id: "art" }),
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    const updated = await system.lawDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(updated.status).toBe("ready");
    expect(updated.durationMs).toBe(12_000);
    expect(updated.statusDetail).toContain("Machine transcript");

    const windowed = await app.request(
      `/api/law/cases/${caseId}/documents/${doc.id}/segments?from=4000&to=7000`,
      { headers: { authorization: "Bearer test" } },
    );
    expect(windowed.status).toBe(200);
    const body = (await windowed.json()) as {
      segments: Array<{ text: string; startMs: number; endMs: number }>;
    };
    expect(body.segments).toEqual([
      expect.objectContaining({ text: "Bravo", startMs: 5000, endMs: 6500 }),
    ]);
  });
});
