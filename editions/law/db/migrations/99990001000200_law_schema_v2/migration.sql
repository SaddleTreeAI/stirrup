-- Library / PDF / video / soft-delete columns and child tables.

-- Cases: soft delete, purge scheduling, creator, legal hold.
ALTER TABLE "law_cases" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "law_cases" ADD COLUMN "deletedBy" TEXT;
ALTER TABLE "law_cases" ADD COLUMN "purgeAfter" TIMESTAMP(3);
ALTER TABLE "law_cases" ADD COLUMN "createdBy" TEXT;
ALTER TABLE "law_cases" ADD COLUMN "legalHold" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "law_cases_spaceId_deletedAt_idx" ON "law_cases"("spaceId", "deletedAt");

-- Documents: upload metadata, processing status, soft delete.
ALTER TABLE "law_documents" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'bot';
ALTER TABLE "law_documents" ADD COLUMN "mimeType" TEXT NOT NULL DEFAULT '';
ALTER TABLE "law_documents" ADD COLUMN "sizeBytes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "law_documents" ADD COLUMN "sha256" TEXT NOT NULL DEFAULT '';
ALTER TABLE "law_documents" ADD COLUMN "artifactId" TEXT;
ALTER TABLE "law_documents" ADD COLUMN "derivedArtifactId" TEXT;
ALTER TABLE "law_documents" ADD COLUMN "speakerNames" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "law_documents" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE "law_documents" ADD COLUMN "statusDetail" TEXT NOT NULL DEFAULT '';
ALTER TABLE "law_documents" ADD COLUMN "pageCount" INTEGER;
ALTER TABLE "law_documents" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "law_documents" ADD COLUMN "uploadedBy" TEXT;
ALTER TABLE "law_documents" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "law_documents" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "law_documents_caseId_deletedAt_idx" ON "law_documents"("caseId", "deletedAt");

-- Cases with exactly one member were created by that member; others stay NULL.
UPDATE "law_cases"
SET "createdBy" = (
  SELECT m."userId" FROM "law_case_members" m WHERE m."caseId" = "law_cases"."id"
)
WHERE (
  SELECT count(*) FROM "law_case_members" m WHERE m."caseId" = "law_cases"."id"
) = 1;

-- Existing rows: bot-sourced when a run id is set, otherwise an edit; size and mime from body.
UPDATE "law_documents"
SET
  "source" = CASE WHEN "sourceRunId" IS NOT NULL THEN 'bot' ELSE 'edit' END,
  "sizeBytes" = octet_length("body"),
  "mimeType" = 'text/plain'
WHERE "mimeType" = '';

-- PDF page text (and OCR output).
CREATE TABLE "law_document_pages" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "ocr" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "law_document_pages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "law_document_pages_documentId_page_key" ON "law_document_pages"("documentId", "page");
CREATE INDEX "law_document_pages_documentId_idx" ON "law_document_pages"("documentId");

-- Transcript segments (audio / video).
CREATE TABLE "law_transcript_segments" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "speaker" TEXT,
    "text" TEXT NOT NULL,
    CONSTRAINT "law_transcript_segments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "law_transcript_segments_documentId_idx_key" ON "law_transcript_segments"("documentId", "idx");
CREATE INDEX "law_transcript_segments_documentId_startMs_idx" ON "law_transcript_segments"("documentId", "startMs");

-- Sampled media frames with optional caption / artifact.
CREATE TABLE "law_media_frames" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "tMs" INTEGER NOT NULL,
    "artifactId" TEXT,
    "caption" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "law_media_frames_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "law_media_frames_documentId_tMs_key" ON "law_media_frames"("documentId", "tMs");

-- Background jobs (extract, OCR, transcribe, purge, …).
CREATE TABLE "law_jobs" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "documentId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "error" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "law_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "law_jobs_status_runAfter_idx" ON "law_jobs"("status", "runAfter");
CREATE INDEX "law_jobs_caseId_idx" ON "law_jobs"("caseId");
CREATE INDEX "law_jobs_documentId_idx" ON "law_jobs"("documentId");

-- FKs for referential cleanup (not declared in Prisma; scalars only there).
-- Children of law_documents: drop with the document.
ALTER TABLE "law_document_pages" ADD CONSTRAINT "law_document_pages_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "law_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "law_transcript_segments" ADD CONSTRAINT "law_transcript_segments_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "law_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "law_media_frames" ADD CONSTRAINT "law_media_frames_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "law_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Jobs belong to a case; document is optional and cleared if the document goes.
ALTER TABLE "law_jobs" ADD CONSTRAINT "law_jobs_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "law_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "law_jobs" ADD CONSTRAINT "law_jobs_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "law_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "law_document_pages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "law_document_pages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "law_document_pages_tenant" ON "law_document_pages"
  USING (EXISTS (
    SELECT 1 FROM "law_documents" d
    JOIN "law_cases" c ON c."id" = d."caseId"
    WHERE d."id" = "law_document_pages"."documentId"
      AND c."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "law_documents" d
    JOIN "law_cases" c ON c."id" = d."caseId"
    WHERE d."id" = "law_document_pages"."documentId"
      AND c."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY "law_document_pages_system" ON "law_document_pages"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "law_transcript_segments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "law_transcript_segments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "law_transcript_segments_tenant" ON "law_transcript_segments"
  USING (EXISTS (
    SELECT 1 FROM "law_documents" d
    JOIN "law_cases" c ON c."id" = d."caseId"
    WHERE d."id" = "law_transcript_segments"."documentId"
      AND c."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "law_documents" d
    JOIN "law_cases" c ON c."id" = d."caseId"
    WHERE d."id" = "law_transcript_segments"."documentId"
      AND c."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY "law_transcript_segments_system" ON "law_transcript_segments"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "law_media_frames" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "law_media_frames" FORCE ROW LEVEL SECURITY;
CREATE POLICY "law_media_frames_tenant" ON "law_media_frames"
  USING (EXISTS (
    SELECT 1 FROM "law_documents" d
    JOIN "law_cases" c ON c."id" = d."caseId"
    WHERE d."id" = "law_media_frames"."documentId"
      AND c."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "law_documents" d
    JOIN "law_cases" c ON c."id" = d."caseId"
    WHERE d."id" = "law_media_frames"."documentId"
      AND c."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY "law_media_frames_system" ON "law_media_frames"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "law_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "law_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "law_jobs_tenant" ON "law_jobs"
  USING (EXISTS (
    SELECT 1 FROM "law_cases" c
    WHERE c."id" = "law_jobs"."caseId"
      AND c."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "law_cases" c
    WHERE c."id" = "law_jobs"."caseId"
      AND c."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY "law_jobs_system" ON "law_jobs"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "law_document_pages", "law_transcript_segments", "law_media_frames", "law_jobs"
  TO rakazo_app;
