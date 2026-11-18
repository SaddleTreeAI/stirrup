-- Cases, membership, library files, and review drafts.

CREATE TABLE "law_cases" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "law_cases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "law_cases_spaceId_slug_key" ON "law_cases"("spaceId", "slug");
CREATE INDEX "law_cases_spaceId_position_idx" ON "law_cases"("spaceId", "position");

ALTER TABLE "law_cases" ADD CONSTRAINT "law_cases_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "law_case_members" (
    "caseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "law_case_members_pkey" PRIMARY KEY ("caseId", "userId")
);

CREATE INDEX "law_case_members_userId_idx" ON "law_case_members"("userId");

ALTER TABLE "law_case_members" ADD CONSTRAINT "law_case_members_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "law_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "law_documents" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "law_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "law_documents_sourceRunId_key" ON "law_documents"("sourceRunId");
CREATE INDEX "law_documents_caseId_kind_createdAt_idx" ON "law_documents"("caseId", "kind", "createdAt");

ALTER TABLE "law_documents" ADD CONSTRAINT "law_documents_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "law_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "law_case_bots" (
    "caseId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    CONSTRAINT "law_case_bots_pkey" PRIMARY KEY ("caseId", "role")
);

CREATE UNIQUE INDEX "law_case_bots_botId_key" ON "law_case_bots"("botId");

ALTER TABLE "law_case_bots" ADD CONSTRAINT "law_case_bots_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "law_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "law_case_bots" ADD CONSTRAINT "law_case_bots_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "law_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "law_cases" FORCE ROW LEVEL SECURITY;
CREATE POLICY "law_cases_tenant" ON "law_cases"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY "law_cases_system" ON "law_cases"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "law_case_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "law_case_members" FORCE ROW LEVEL SECURITY;
CREATE POLICY "law_case_members_tenant" ON "law_case_members"
  USING (EXISTS (
    SELECT 1 FROM "law_cases" c
    WHERE c."id" = "law_case_members"."caseId"
      AND c."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "law_cases" c
    WHERE c."id" = "law_case_members"."caseId"
      AND c."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY "law_case_members_system" ON "law_case_members"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "law_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "law_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "law_documents_tenant" ON "law_documents"
  USING (EXISTS (
    SELECT 1 FROM "law_cases" c
    WHERE c."id" = "law_documents"."caseId"
      AND c."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "law_cases" c
    WHERE c."id" = "law_documents"."caseId"
      AND c."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY "law_documents_system" ON "law_documents"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "law_case_bots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "law_case_bots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "law_case_bots_tenant" ON "law_case_bots"
  USING (EXISTS (
    SELECT 1 FROM "law_cases" c
    WHERE c."id" = "law_case_bots"."caseId"
      AND c."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "law_cases" c
    WHERE c."id" = "law_case_bots"."caseId"
      AND c."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY "law_case_bots_system" ON "law_case_bots"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

-- Core sets ALTER DEFAULT PRIVILEGES for rakazo_app; repeat the grant so a
-- migration role without those defaults still leaves the runtime login usable.
GRANT SELECT, INSERT, UPDATE, DELETE ON "law_cases", "law_case_members", "law_documents", "law_case_bots" TO rakazo_app;
