-- Platform invitations are server-side credentials. Only explicitly named
-- system operations (invite administration, preview, and redemption) may read
-- or write them; tenant contexts have no policy grant.
ALTER TABLE "platform_invites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_invites" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_invites_system ON "platform_invites"
  USING ((SELECT app_rls_bypass()))
  WITH CHECK ((SELECT app_rls_bypass()));
