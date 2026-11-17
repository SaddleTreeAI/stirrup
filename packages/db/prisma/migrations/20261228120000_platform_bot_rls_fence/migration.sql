-- Company bot access is an additional fence: it ANDs with each existing tenant policy.
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT schemaname, tablename, policyname FROM pg_policies
    WHERE policyname LIKE '%_platform_bot_%' OR policyname IN (
      'chat_groups_tenant', 'chat_groups_system', 'chat_group_members_tenant', 'chat_group_members_system',
      'bot_sections_tenant', 'bot_sections_system', 'computer_updates_tenant', 'computer_updates_system',
      'attempts_tenant', 'attempts_system', 'external_effects_tenant', 'external_effects_system',
      'bot_email_messages_owner_fence'
    )
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS app_company_computer_allowed(text, text, text, text);

CREATE OR REPLACE FUNCTION app_company_permission_at_least(required text, needed text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE needed
    WHEN 'use' THEN required IN ('use', 'edit', 'manage')
    WHEN 'edit' THEN required IN ('edit', 'manage')
    WHEN 'manage' THEN required = 'manage'
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION app_company_is_space(p_space_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off AS $$
  SELECT EXISTS (SELECT 1 FROM "deployment_settings" ds WHERE ds."companySpaceId" = p_space_id)
$$;

CREATE OR REPLACE FUNCTION app_company_bot_allowed(p_bot_id text, p_permission text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off AS $$
DECLARE bot_space text; bot_owner text; company_space text; requested text; allowed_ids text[];
BEGIN
  IF app_rls_bypass() THEN RETURN true; END IF;
  IF p_bot_id IS NULL THEN RETURN true; END IF;
  SELECT b."spaceId", b."userId" INTO bot_space, bot_owner FROM "bots" b WHERE b."id" = p_bot_id;
  SELECT ds."companySpaceId" INTO company_space FROM "deployment_settings" ds LIMIT 1;
  IF bot_space IS NULL THEN
    -- INSERT ... RETURNING can evaluate the SELECT fence before the new bot is
    -- visible to this SECURITY DEFINER lookup. Allow only the dedicated
    -- computer-backed bot being created by the current manager.
    requested := NULLIF(current_setting('app.platform_bot_required_permission', true), '');
    RETURN company_space IS NOT NULL
      AND NULLIF(current_setting('app.company_space_id', true), '') = company_space
      AND NULLIF(current_setting('app.space_id', true), '') = company_space
      AND NULLIF(current_setting('app.user_id', true), '') IS NOT NULL
      AND current_setting('app.platform_bot_required_permission', true) = 'manage'
      AND cardinality(string_to_array(COALESCE(current_setting('app.platform_bot_manage_ids', true), ''), ',')) > 0
      AND EXISTS (SELECT 1 FROM "computers" c WHERE c."spaceId" = company_space
        AND c."userId" = NULLIF(current_setting('app.user_id', true), '')
        AND c."scopeKey" = 'bot:' || p_bot_id);
  END IF;
  IF company_space IS NULL OR bot_space <> company_space THEN RETURN true; END IF;
  IF NULLIF(current_setting('app.company_space_id', true), '') IS DISTINCT FROM company_space
     OR NULLIF(current_setting('app.space_id', true), '') IS DISTINCT FROM company_space THEN RETURN false; END IF;
  requested := NULLIF(current_setting('app.platform_bot_required_permission', true), '');
  IF NOT app_company_permission_at_least(requested, p_permission) THEN RETURN false; END IF;
  IF bot_owner = NULLIF(current_setting('app.user_id', true), '') THEN RETURN true; END IF;
  IF p_permission = 'manage' THEN
    allowed_ids := string_to_array(COALESCE(current_setting('app.platform_bot_manage_ids', true), ''), ',');
  ELSIF p_permission = 'edit' THEN
    allowed_ids := string_to_array(concat_ws(',', NULLIF(current_setting('app.platform_bot_edit_ids', true), ''), NULLIF(current_setting('app.platform_bot_manage_ids', true), '')), ',');
  ELSIF p_permission = 'use' THEN
    allowed_ids := string_to_array(concat_ws(',', NULLIF(current_setting('app.platform_bot_use_ids', true), ''), NULLIF(current_setting('app.platform_bot_edit_ids', true), ''), NULLIF(current_setting('app.platform_bot_manage_ids', true), '')), ',');
  ELSE
    RETURN false;
  END IF;
  RETURN p_bot_id = ANY(allowed_ids);
END;
$$;

CREATE OR REPLACE FUNCTION app_company_space_context_allowed(p_space_id text, p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off AS $$
  SELECT CASE WHEN app_rls_bypass() THEN true WHEN NOT app_company_is_space(p_space_id) THEN true ELSE
    NULLIF(current_setting('app.company_space_id', true), '') = p_space_id
    AND NULLIF(current_setting('app.space_id', true), '') = p_space_id
    AND app_company_permission_at_least(
      NULLIF(current_setting('app.platform_bot_required_permission', true), ''), p_permission)
  END
$$;

CREATE OR REPLACE FUNCTION app_company_bot_row_allowed(p_bot_id text, p_space_id text, p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off AS $$
  SELECT CASE WHEN app_rls_bypass() OR NOT app_company_is_space(p_space_id) THEN true ELSE
    NULLIF(current_setting('app.company_space_id', true), '') = p_space_id
    AND NULLIF(current_setting('app.space_id', true), '') = p_space_id
    AND app_company_permission_at_least(NULLIF(current_setting('app.platform_bot_required_permission', true), ''), p_permission)
    AND p_bot_id = ANY(CASE p_permission
      WHEN 'manage' THEN string_to_array(COALESCE(current_setting('app.platform_bot_manage_ids', true), ''), ',')
      WHEN 'edit' THEN string_to_array(concat_ws(',', NULLIF(current_setting('app.platform_bot_edit_ids', true), ''), NULLIF(current_setting('app.platform_bot_manage_ids', true), '')), ',')
      ELSE string_to_array(concat_ws(',', NULLIF(current_setting('app.platform_bot_use_ids', true), ''), NULLIF(current_setting('app.platform_bot_edit_ids', true), ''), NULLIF(current_setting('app.platform_bot_manage_ids', true), '')), ',')
    END)
  END
$$;

CREATE OR REPLACE FUNCTION app_company_bot_create_allowed(p_bot_id text, p_space_id text, p_user_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off AS $$
  SELECT CASE WHEN app_rls_bypass() OR NOT app_company_is_space(p_space_id) THEN true ELSE
    p_user_id = NULLIF(current_setting('app.user_id', true), '')
    AND NULLIF(current_setting('app.company_space_id', true), '') = p_space_id
    AND NULLIF(current_setting('app.space_id', true), '') = p_space_id
    AND current_setting('app.platform_bot_required_permission', true) = 'manage'
    AND cardinality(string_to_array(COALESCE(current_setting('app.platform_bot_manage_ids', true), ''), ',')) > 0
  END
$$;

CREATE OR REPLACE FUNCTION app_company_bot_or_owner_allowed(p_bot_id text, p_space_id text, p_user_id text, p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off AS $$
  SELECT CASE
    WHEN app_rls_bypass() THEN true
    WHEN NOT app_company_is_space(p_space_id) THEN true
    WHEN p_bot_id IS NULL THEN app_company_space_context_allowed(p_space_id, p_permission)
      AND p_user_id = NULLIF(current_setting('app.user_id', true), '')
    ELSE app_company_bot_allowed(p_bot_id, p_permission)
  END
$$;

CREATE OR REPLACE FUNCTION app_company_computer_allowed(p_computer_id text, p_space_id text, p_control_bot_id text, p_permission text, p_scope_key text, p_user_id text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off AS $$
DECLARE attached_count integer; inaccessible_count integer; scoped_bot_id text; total_bot_count integer;
BEGIN
  IF app_rls_bypass() THEN RETURN true; END IF;
  IF NOT app_company_is_space(p_space_id) THEN RETURN true; END IF;
  IF NOT app_company_space_context_allowed(p_space_id, p_permission) THEN RETURN false; END IF;
  SELECT count(*), count(*) FILTER (WHERE b."userId" <> NULLIF(current_setting('app.user_id', true), '') AND NOT app_company_bot_allowed(b."id", p_permission))
    INTO attached_count, inaccessible_count FROM "bots" b WHERE b."computerId" = p_computer_id;
  IF attached_count > 0 AND inaccessible_count > 0 THEN RETURN false; END IF;
  IF attached_count = 0 THEN
    IF p_scope_key LIKE 'bot:%' THEN
      scoped_bot_id := substring(p_scope_key FROM 5);
      IF EXISTS (SELECT 1 FROM "bots" b WHERE b."id" = scoped_bot_id AND b."spaceId" = p_space_id) THEN
        IF NOT app_company_bot_allowed(scoped_bot_id, p_permission) THEN RETURN false; END IF;
      ELSE
        RETURN p_user_id = NULLIF(current_setting('app.user_id', true), '')
          AND current_setting('app.platform_bot_required_permission', true) = 'manage'
          AND cardinality(string_to_array(COALESCE(current_setting('app.platform_bot_manage_ids', true), ''), ',')) > 0;
      END IF;
    ELSIF p_scope_key LIKE 'team:%' THEN
      SELECT count(*) INTO total_bot_count FROM "bots" b WHERE b."spaceId" = p_space_id;
      IF total_bot_count = 0 OR current_setting('app.platform_bot_required_permission', true) <> 'manage'
        OR EXISTS (SELECT 1 FROM "bots" b WHERE b."spaceId" = p_space_id AND NOT app_company_bot_allowed(b."id", 'manage')) THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
    END IF;
  END IF;
  RETURN p_control_bot_id IS NULL OR EXISTS (SELECT 1 FROM "bots" b WHERE b."id" = p_control_bot_id AND (b."userId" = NULLIF(current_setting('app.user_id', true), '') OR app_company_bot_allowed(p_control_bot_id, p_permission)));
END;
$$;

CREATE OR REPLACE FUNCTION app_company_group_allowed(p_group_id text, p_permission text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off AS $$
DECLARE group_space text;
BEGIN
  IF app_rls_bypass() THEN RETURN true; END IF;
  SELECT g."spaceId" INTO group_space FROM "chat_groups" g WHERE g."id" = p_group_id;
  IF group_space IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM "deployment_settings" ds WHERE ds."companySpaceId" = group_space) THEN RETURN true; END IF;
  IF NOT app_company_space_context_allowed(group_space, p_permission) THEN RETURN false; END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM "chat_group_members" gm
    WHERE gm."groupId" = p_group_id AND NOT app_company_bot_allowed(gm."botId", p_permission)
  );
END;
$$;

CREATE OR REPLACE FUNCTION app_company_section_allowed(p_section_id text, p_permission text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off AS $$
DECLARE section_space text;
BEGIN
  IF app_rls_bypass() THEN RETURN true; END IF;
  SELECT s."spaceId" INTO section_space FROM "bot_sections" s WHERE s."id" = p_section_id;
  IF section_space IS NULL THEN RETURN false; END IF;
  IF NOT app_company_is_space(section_space) THEN RETURN true; END IF;
  IF NOT app_company_space_context_allowed(section_space, p_permission) THEN RETURN false; END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM "bots" b WHERE b."sectionId" = p_section_id AND NOT app_company_bot_allowed(b."id", p_permission)
  ) AND NOT EXISTS (
    SELECT 1 FROM "chat_groups" g WHERE g."sectionId" = p_section_id AND NOT app_company_group_allowed(g."id", p_permission)
  );
END;
$$;

CREATE OR REPLACE FUNCTION app_company_thread_row_allowed(p_space_id text, p_bot_id text, p_helper_bot_id text, p_group_id text, p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off AS $$
  SELECT CASE WHEN NOT app_company_is_space(p_space_id) THEN true ELSE
    app_company_space_context_allowed(p_space_id, p_permission)
    AND ((p_bot_id IS NOT NULL AND app_company_bot_row_allowed(p_bot_id, p_space_id, p_permission))
      OR (p_helper_bot_id IS NOT NULL AND app_company_bot_row_allowed(p_helper_bot_id, p_space_id, p_permission))
      OR (p_group_id IS NOT NULL AND app_company_group_allowed(p_group_id, p_permission)))
  END
$$;

CREATE OR REPLACE FUNCTION app_company_thread_allowed(p_thread_id text, p_permission text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off AS $$
DECLARE row_space text; row_bot text; helper_bot text; group_id text;
BEGIN
  IF app_rls_bypass() THEN RETURN true; END IF;
  SELECT t."spaceId", t."botId", t."helperBotId", t."groupId"
    INTO row_space, row_bot, helper_bot, group_id FROM "threads" t WHERE t."id" = p_thread_id;
  IF row_space IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM "deployment_settings" ds WHERE ds."companySpaceId" = row_space) THEN RETURN true; END IF;
  IF NOT app_company_space_context_allowed(row_space, p_permission) THEN RETURN false; END IF;
  IF row_bot IS NOT NULL AND NOT app_company_bot_allowed(row_bot, p_permission) THEN RETURN false; END IF;
  IF helper_bot IS NOT NULL AND NOT app_company_bot_allowed(helper_bot, p_permission) THEN RETURN false; END IF;
  IF group_id IS NOT NULL AND NOT app_company_group_allowed(group_id, p_permission) THEN RETURN false; END IF;
  RETURN row_bot IS NOT NULL OR helper_bot IS NOT NULL OR group_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app_company_ticket_allowed(p_ticket_id text, p_permission text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off AS $$
DECLARE row_space text; assignee text; creator text;
BEGIN
  IF app_rls_bypass() THEN RETURN true; END IF;
  SELECT t."spaceId", t."assigneeBotId", t."createdByBotId"
    INTO row_space, assignee, creator FROM "tickets" t WHERE t."id" = p_ticket_id;
  IF row_space IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM "deployment_settings" ds WHERE ds."companySpaceId" = row_space) THEN RETURN true; END IF;
  IF NOT app_company_space_context_allowed(row_space, p_permission) THEN RETURN false; END IF;
  RETURN (assignee IS NULL OR app_company_bot_allowed(assignee, p_permission))
    AND (creator IS NULL OR app_company_bot_allowed(creator, p_permission));
END;
$$;

-- Tables that did not previously have tenant RLS: preserve same-Space access for this
-- release and the previous release, then add a restrictive company-space fence.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['chat_groups', 'bot_sections'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING ("spaceId" = NULLIF(current_setting(''app.space_id'', true), ''''))', table_name || '_tenant', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING ((SELECT app_rls_bypass()))', table_name || '_system', table_name);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL USING (app_company_space_context_allowed("spaceId", ''use'')) WITH CHECK (app_company_space_context_allowed("spaceId", ''edit''))', table_name || '_platform_bot_fence', table_name);
  END LOOP;
  ALTER TABLE "chat_group_members" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY chat_group_members_tenant ON "chat_group_members"
    USING (EXISTS (
      SELECT 1 FROM "chat_groups" g WHERE g."id" = "chat_group_members"."groupId"
        AND g."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    ));
  CREATE POLICY chat_group_members_system ON "chat_group_members" USING ((SELECT app_rls_bypass()));
END $$;

ALTER TABLE "computer_updates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY computer_updates_tenant ON "computer_updates" USING (
  EXISTS (
    SELECT 1 FROM "bots" b WHERE b."id" = "computer_updates"."botId"
      AND b."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  )
);
CREATE POLICY computer_updates_system ON "computer_updates" USING ((SELECT app_rls_bypass()));

ALTER TABLE "attempts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY attempts_tenant ON "attempts" USING (
  EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = "attempts"."runId"
    AND r."spaceId" = NULLIF(current_setting('app.space_id', true), ''))
);
CREATE POLICY attempts_system ON "attempts" USING ((SELECT app_rls_bypass()));
ALTER TABLE "external_effects" ENABLE ROW LEVEL SECURITY;
CREATE POLICY external_effects_tenant ON "external_effects" USING (
  "spaceId" = NULLIF(current_setting('app.space_id', true), '')
);
CREATE POLICY external_effects_system ON "external_effects" USING ((SELECT app_rls_bypass()));

-- Bot rows have operation-specific requirements. The procedure map is server-side;
-- unknown operations carry `deny` and this policy rejects them.
CREATE POLICY bots_platform_bot_select ON "bots" AS RESTRICTIVE FOR SELECT
  USING (app_company_bot_allowed("id", 'use'));
CREATE POLICY bots_platform_bot_insert ON "bots" AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_company_bot_create_allowed("id", "spaceId", "userId"));
CREATE POLICY bots_platform_bot_update ON "bots" AS RESTRICTIVE FOR UPDATE
  USING (app_company_bot_allowed("id", 'edit')) WITH CHECK (app_company_bot_allowed("id", 'edit'));
CREATE POLICY bots_platform_bot_delete ON "bots" AS RESTRICTIVE FOR DELETE
  USING (app_company_bot_allowed("id", 'manage'));

-- Simple rows with a direct botId foreign key. Content reads need use; writes need edit;
-- deletes are reserved for manage. Existing non-company Space policies remain in force.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'runs', 'tasks', 'steering_messages', 'external_conversations'
  ] LOOP
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR SELECT USING (app_company_bot_allowed("botId", ''use''))', table_name || '_platform_bot_select', table_name);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR INSERT WITH CHECK (app_company_bot_allowed("botId", ''use''))', table_name || '_platform_bot_insert', table_name);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR UPDATE USING (app_company_bot_allowed("botId", ''use'')) WITH CHECK (app_company_bot_allowed("botId", ''use''))', table_name || '_platform_bot_update', table_name);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE USING (app_company_bot_allowed("botId", ''manage''))', table_name || '_platform_bot_delete', table_name);
  END LOOP;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['routines', 'taught_skills', 'bot_mcp_servers', 'agent_imports', 'scratchpad_items'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR SELECT USING (app_company_bot_allowed("botId", ''use''))', table_name || '_platform_bot_select', table_name);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR INSERT WITH CHECK (app_company_bot_allowed("botId", ''edit''))', table_name || '_platform_bot_insert', table_name);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR UPDATE USING (app_company_bot_allowed("botId", ''edit'')) WITH CHECK (app_company_bot_allowed("botId", ''edit''))', table_name || '_platform_bot_update', table_name);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE USING (app_company_bot_allowed("botId", ''edit''))', table_name || '_platform_bot_delete', table_name);
  END LOOP;
END $$;

CREATE POLICY computer_updates_platform_bot_fence ON "computer_updates" AS RESTRICTIVE FOR ALL
  USING (app_company_bot_allowed("botId", 'use')) WITH CHECK (app_company_bot_allowed("botId", 'use'));

-- Thread-linked records inherit the thread's bot, helper-bot, and group membership fence.
CREATE POLICY threads_platform_bot_select ON "threads" AS RESTRICTIVE FOR SELECT USING (app_company_thread_allowed("id", 'use'));
CREATE POLICY threads_platform_bot_insert ON "threads" AS RESTRICTIVE FOR INSERT WITH CHECK (app_company_thread_row_allowed("spaceId", "botId", "helperBotId", "groupId", 'use'));
CREATE POLICY threads_platform_bot_update ON "threads" AS RESTRICTIVE FOR UPDATE USING (app_company_thread_allowed("id", 'use')) WITH CHECK (app_company_thread_allowed("id", 'use'));
CREATE POLICY threads_platform_bot_delete ON "threads" AS RESTRICTIVE FOR DELETE USING (app_company_thread_allowed("id", 'manage'));
CREATE POLICY messages_platform_bot_select ON "messages" AS RESTRICTIVE FOR SELECT USING (app_company_thread_allowed("threadId", 'use'));
CREATE POLICY messages_platform_bot_insert ON "messages" AS RESTRICTIVE FOR INSERT WITH CHECK (app_company_thread_allowed("threadId", 'use'));
CREATE POLICY messages_platform_bot_update ON "messages" AS RESTRICTIVE FOR UPDATE USING (app_company_thread_allowed("threadId", 'use')) WITH CHECK (app_company_thread_allowed("threadId", 'use'));
CREATE POLICY messages_platform_bot_delete ON "messages" AS RESTRICTIVE FOR DELETE USING (app_company_thread_allowed("threadId", 'manage'));
CREATE POLICY events_platform_bot_select ON "events" AS RESTRICTIVE FOR SELECT USING (app_company_thread_allowed("threadId", 'use'));
CREATE POLICY events_platform_bot_insert ON "events" AS RESTRICTIVE FOR INSERT WITH CHECK (app_company_thread_allowed("threadId", 'use'));
CREATE POLICY events_platform_bot_update ON "events" AS RESTRICTIVE FOR UPDATE USING (app_company_thread_allowed("threadId", 'use')) WITH CHECK (app_company_thread_allowed("threadId", 'use'));
CREATE POLICY events_platform_bot_delete ON "events" AS RESTRICTIVE FOR DELETE USING (app_company_thread_allowed("threadId", 'manage'));
CREATE POLICY thread_reads_platform_bot_fence ON "thread_reads" AS RESTRICTIVE FOR ALL
  USING (app_company_thread_allowed("threadId", 'use')) WITH CHECK (app_company_thread_allowed("threadId", 'use'));

CREATE POLICY memory_documents_platform_bot_fence ON "memory_documents" AS RESTRICTIVE FOR ALL
  USING (app_company_bot_or_owner_allowed("botId", "spaceId", "userId", 'use')) WITH CHECK (app_company_bot_or_owner_allowed("botId", "spaceId", "userId", 'edit'));
CREATE POLICY memory_documents_platform_bot_delete ON "memory_documents" AS RESTRICTIVE FOR DELETE
  USING (app_company_bot_or_owner_allowed("botId", "spaceId", "userId", 'edit'));
CREATE POLICY memory_revisions_platform_bot_fence ON "memory_revisions" AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM "memory_documents" d WHERE d."id" = "memory_revisions"."documentId" AND app_company_bot_allowed(d."botId", 'use')))
  WITH CHECK (EXISTS (SELECT 1 FROM "memory_documents" d WHERE d."id" = "memory_revisions"."documentId" AND app_company_bot_allowed(d."botId", 'edit')));
CREATE POLICY memory_revisions_platform_bot_delete ON "memory_revisions" AS RESTRICTIVE FOR DELETE
  USING (EXISTS (SELECT 1 FROM "memory_documents" d WHERE d."id" = "memory_revisions"."documentId" AND app_company_bot_allowed(d."botId", 'edit')));
CREATE POLICY artifacts_platform_bot_fence ON "artifacts" AS RESTRICTIVE FOR ALL
  USING (app_company_bot_or_owner_allowed("botId", "spaceId", "userId", 'use') AND ("groupId" IS NULL OR app_company_group_allowed("groupId", 'use')))
  WITH CHECK (app_company_bot_or_owner_allowed("botId", "spaceId", "userId", 'edit') AND ("groupId" IS NULL OR app_company_group_allowed("groupId", 'edit')));
CREATE POLICY artifacts_platform_bot_delete ON "artifacts" AS RESTRICTIVE FOR DELETE
  USING (app_company_bot_or_owner_allowed("botId", "spaceId", "userId", 'edit') AND ("groupId" IS NULL OR app_company_group_allowed("groupId", 'edit')));

-- Group and group-member rows are visible only when every included bot is visible.
CREATE POLICY chat_groups_platform_bot_select ON "chat_groups" AS RESTRICTIVE FOR SELECT USING (app_company_group_allowed("id", 'use'));
CREATE POLICY chat_groups_platform_bot_insert ON "chat_groups" AS RESTRICTIVE FOR INSERT WITH CHECK (app_company_space_context_allowed("spaceId", 'edit'));
CREATE POLICY chat_groups_platform_bot_update ON "chat_groups" AS RESTRICTIVE FOR UPDATE USING (app_company_group_allowed("id", 'edit')) WITH CHECK (app_company_group_allowed("id", 'edit'));
CREATE POLICY chat_groups_platform_bot_delete ON "chat_groups" AS RESTRICTIVE FOR DELETE USING (app_company_group_allowed("id", 'manage'));
CREATE POLICY bot_sections_platform_bot_select ON "bot_sections" AS RESTRICTIVE FOR SELECT USING (app_company_section_allowed("id", 'use'));
CREATE POLICY bot_sections_platform_bot_insert ON "bot_sections" AS RESTRICTIVE FOR INSERT WITH CHECK (app_company_space_context_allowed("spaceId", 'edit'));
CREATE POLICY bot_sections_platform_bot_update ON "bot_sections" AS RESTRICTIVE FOR UPDATE USING (app_company_section_allowed("id", 'edit')) WITH CHECK (app_company_section_allowed("id", 'edit'));
CREATE POLICY bot_sections_platform_bot_delete ON "bot_sections" AS RESTRICTIVE FOR DELETE USING (app_company_section_allowed("id", 'edit'));
CREATE POLICY chat_group_members_platform_bot_select ON "chat_group_members" AS RESTRICTIVE FOR SELECT USING (app_company_group_allowed("groupId", 'use') AND app_company_bot_allowed("botId", 'use'));
CREATE POLICY chat_group_members_platform_bot_insert ON "chat_group_members" AS RESTRICTIVE FOR INSERT WITH CHECK (app_company_group_allowed("groupId", 'edit') AND app_company_bot_allowed("botId", 'edit'));
CREATE POLICY chat_group_members_platform_bot_update ON "chat_group_members" AS RESTRICTIVE FOR UPDATE USING (app_company_group_allowed("groupId", 'edit') AND app_company_bot_allowed("botId", 'edit')) WITH CHECK (app_company_group_allowed("groupId", 'edit') AND app_company_bot_allowed("botId", 'edit'));
CREATE POLICY chat_group_members_platform_bot_delete ON "chat_group_members" AS RESTRICTIVE FOR DELETE USING (app_company_group_allowed("groupId", 'edit') AND app_company_bot_allowed("botId", 'edit'));

CREATE POLICY ticket_comments_platform_bot_fence ON "ticket_comments" AS RESTRICTIVE FOR ALL
  USING (app_company_ticket_allowed("ticketId", 'use') AND app_company_bot_allowed("authorBotId", 'use'))
  WITH CHECK (app_company_ticket_allowed("ticketId", 'edit') AND app_company_bot_allowed("authorBotId", 'edit'));
CREATE POLICY ticket_comments_platform_bot_delete ON "ticket_comments" AS RESTRICTIVE FOR DELETE
  USING (app_company_ticket_allowed("ticketId", 'edit') AND app_company_bot_allowed("authorBotId", 'edit'));
CREATE POLICY tickets_platform_bot_fence ON "tickets" AS RESTRICTIVE FOR ALL
  USING (app_company_ticket_allowed("id", 'use')) WITH CHECK (app_company_ticket_allowed("id", 'edit'));
CREATE POLICY tickets_platform_bot_delete ON "tickets" AS RESTRICTIVE FOR DELETE
  USING (app_company_ticket_allowed("id", 'manage'));
CREATE POLICY boards_platform_bot_fence ON "boards" AS RESTRICTIVE FOR ALL
  USING (app_company_space_context_allowed("spaceId", 'use')) WITH CHECK (app_company_space_context_allowed("spaceId", 'edit'));
CREATE POLICY boards_platform_bot_delete ON "boards" AS RESTRICTIVE FOR DELETE
  USING (app_company_space_context_allowed("spaceId", 'manage'));
CREATE POLICY pages_platform_bot_fence ON "pages" AS RESTRICTIVE FOR ALL
  USING (app_company_bot_or_owner_allowed("botId", "spaceId", "userId", 'use') AND ("groupId" IS NULL OR app_company_group_allowed("groupId", 'use')))
  WITH CHECK (app_company_bot_or_owner_allowed("botId", "spaceId", "userId", 'edit') AND ("groupId" IS NULL OR app_company_group_allowed("groupId", 'edit')));
CREATE POLICY pages_platform_bot_delete ON "pages" AS RESTRICTIVE FOR DELETE
  USING (app_company_bot_or_owner_allowed("botId", "spaceId", "userId", 'edit') AND ("groupId" IS NULL OR app_company_group_allowed("groupId", 'edit')));
CREATE POLICY page_versions_platform_bot_fence ON "page_versions" AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM "pages" p WHERE p."id" = "page_versions"."pageId" AND app_company_bot_or_owner_allowed(p."botId", p."spaceId", p."userId", 'use') AND (p."groupId" IS NULL OR app_company_group_allowed(p."groupId", 'use'))))
  WITH CHECK (EXISTS (SELECT 1 FROM "pages" p WHERE p."id" = "page_versions"."pageId" AND app_company_bot_or_owner_allowed(p."botId", p."spaceId", p."userId", 'edit') AND (p."groupId" IS NULL OR app_company_group_allowed(p."groupId", 'edit'))));
CREATE POLICY page_versions_platform_bot_delete ON "page_versions" AS RESTRICTIVE FOR DELETE
  USING (EXISTS (SELECT 1 FROM "pages" p WHERE p."id" = "page_versions"."pageId" AND app_company_bot_or_owner_allowed(p."botId", p."spaceId", p."userId", 'edit') AND (p."groupId" IS NULL OR app_company_group_allowed(p."groupId", 'edit'))));
CREATE POLICY external_effects_platform_bot_fence ON "external_effects" AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = "external_effects"."runId" AND app_company_bot_allowed(r."botId", 'use')))
  WITH CHECK (EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = "external_effects"."runId" AND app_company_bot_allowed(r."botId", 'use')));
CREATE POLICY attempts_platform_bot_fence ON "attempts" AS RESTRICTIVE FOR ALL
  USING (EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = "attempts"."runId" AND app_company_bot_allowed(r."botId", 'use')))
  WITH CHECK (EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = "attempts"."runId" AND app_company_bot_allowed(r."botId", 'use')));
CREATE POLICY computers_platform_bot_select ON "computers" AS RESTRICTIVE FOR SELECT
  USING (app_company_computer_allowed("id", "spaceId", "controlBotId", 'use', "scopeKey", "userId"));
CREATE POLICY computers_platform_bot_insert ON "computers" AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_company_computer_allowed("id", "spaceId", "controlBotId", 'use', "scopeKey", "userId"));
CREATE POLICY computers_platform_bot_update ON "computers" AS RESTRICTIVE FOR UPDATE
  USING (app_company_computer_allowed("id", "spaceId", "controlBotId", 'use', "scopeKey", "userId"))
  WITH CHECK (app_company_computer_allowed("id", "spaceId", "controlBotId", 'use', "scopeKey", "userId"));
CREATE POLICY computers_platform_bot_delete ON "computers" AS RESTRICTIVE FOR DELETE
  USING (app_company_computer_allowed("id", "spaceId", "controlBotId", 'use', "scopeKey", "userId"));
CREATE POLICY computer_runs_platform_bot_fence ON "computer_runs" AS RESTRICTIVE FOR ALL
  USING ("spaceId" IS NULL OR app_company_computer_allowed("computerId", "spaceId", NULL, 'use', (SELECT c."scopeKey" FROM "computers" c WHERE c."id" = "computer_runs"."computerId"), (SELECT c."userId" FROM "computers" c WHERE c."id" = "computer_runs"."computerId")))
  WITH CHECK ("spaceId" IS NULL OR app_company_computer_allowed("computerId", "spaceId", NULL, 'use', (SELECT c."scopeKey" FROM "computers" c WHERE c."id" = "computer_runs"."computerId"), (SELECT c."userId" FROM "computers" c WHERE c."id" = "computer_runs"."computerId")));
CREATE POLICY agent_skills_platform_bot_fence ON "agent_skills" AS RESTRICTIVE FOR ALL
  USING (app_company_space_context_allowed("spaceId", 'use') AND ("userId" = NULLIF(current_setting('app.user_id', true), '') OR NOT EXISTS (SELECT 1 FROM "deployment_settings" ds WHERE ds."companySpaceId" = "agent_skills"."spaceId")))
  WITH CHECK (app_company_space_context_allowed("spaceId", 'edit') AND ("userId" = NULLIF(current_setting('app.user_id', true), '') OR NOT EXISTS (SELECT 1 FROM "deployment_settings" ds WHERE ds."companySpaceId" = "agent_skills"."spaceId")));
CREATE POLICY agent_skills_platform_bot_delete ON "agent_skills" AS RESTRICTIVE FOR DELETE
  USING (app_company_space_context_allowed("spaceId", 'edit') AND "userId" = NULLIF(current_setting('app.user_id', true), ''));

-- Bot email content remains private to the bot's owner even when the bot itself is shared.
CREATE POLICY bot_email_messages_owner_fence ON "bot_email_messages" AS RESTRICTIVE FOR ALL USING (
  app_company_space_context_allowed("spaceId", 'use') AND EXISTS (
    SELECT 1 FROM "bots" b WHERE b."id" = "bot_email_messages"."botId"
      AND b."userId" = NULLIF(current_setting('app.user_id', true), '')
  )
) WITH CHECK (
  app_company_space_context_allowed("spaceId", 'edit') AND EXISTS (
    SELECT 1 FROM "bots" b WHERE b."id" = "bot_email_messages"."botId"
      AND b."userId" = NULLIF(current_setting('app.user_id', true), '')
  )
);

REVOKE ALL ON FUNCTION app_company_is_space(text), app_company_bot_allowed(text, text), app_company_space_context_allowed(text, text),
  app_company_bot_row_allowed(text, text, text), app_company_bot_create_allowed(text, text, text), app_company_bot_or_owner_allowed(text, text, text, text),
  app_company_computer_allowed(text, text, text, text, text, text), app_company_group_allowed(text, text), app_company_section_allowed(text, text),
  app_company_thread_row_allowed(text, text, text, text, text), app_company_thread_allowed(text, text),
  app_company_ticket_allowed(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_company_is_space(text), app_company_bot_allowed(text, text), app_company_space_context_allowed(text, text),
  app_company_bot_row_allowed(text, text, text), app_company_bot_create_allowed(text, text, text), app_company_bot_or_owner_allowed(text, text, text, text),
  app_company_computer_allowed(text, text, text, text, text, text), app_company_group_allowed(text, text), app_company_section_allowed(text, text),
  app_company_thread_row_allowed(text, text, text, text, text), app_company_thread_allowed(text, text),
  app_company_ticket_allowed(text, text) TO rakazo_app;
