-- Document filenames and version history for library / review drafts.
ALTER TABLE "law_documents" ADD COLUMN "filename" TEXT NOT NULL DEFAULT '';
ALTER TABLE "law_documents" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "law_documents" ADD COLUMN "rootId" TEXT;

UPDATE "law_documents"
SET "filename" = CASE
  WHEN "filename" <> '' THEN "filename"
  WHEN "kind" = 'review' THEN lower(replace(replace("title", ' ', '-'), '/', '-')) || '.md'
  ELSE lower(replace(replace("title", ' ', '-'), '/', '-')) || '.txt'
END
WHERE "filename" = '';

ALTER TABLE "law_documents" ADD CONSTRAINT "law_documents_rootId_fkey"
  FOREIGN KEY ("rootId") REFERENCES "law_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "law_documents_caseId_rootId_version_idx" ON "law_documents"("caseId", "rootId", "version");
