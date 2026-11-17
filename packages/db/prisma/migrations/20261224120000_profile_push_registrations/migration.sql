-- Separate from legacy registrations so old workers cannot reassign saved accounts' devices.
CREATE TABLE "profile_push_registrations" (
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "tokenDigest" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "presentation" TEXT,
  "clientProfileId" TEXT NOT NULL,
  "serverOrigin" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("userId", "tokenDigest")
);
CREATE INDEX "profile_push_registrations_sessionId_idx" ON "profile_push_registrations"("sessionId");
ALTER TABLE "profile_push_registrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "profile_push_registrations" FORCE ROW LEVEL SECURITY;
CREATE POLICY profile_push_registrations_system ON "profile_push_registrations"
  USING ((SELECT app_rls_bypass()));
