-- INSERT ... RETURNING runs the SELECT policy against the new row before a
-- lookup by ID can see it. Evaluate company access from that row's own scope
-- and owner so the first bot can be returned to its creator.
DROP POLICY bots_platform_bot_select ON "bots";
CREATE POLICY bots_platform_bot_select ON "bots" AS RESTRICTIVE FOR SELECT
  USING (
    app_company_bot_row_allowed("id", "spaceId", 'use')
    OR (
      "userId" = NULLIF(current_setting('app.user_id', true), '')
      AND app_company_space_context_allowed("spaceId", 'use')
    )
  );

-- Thread creation happens immediately after bot creation. The bot now exists,
-- so resolve its creator/grant from the stored row rather than requiring the
-- generated bot ID to have been present in the request's precomputed grant set.
CREATE OR REPLACE FUNCTION app_company_thread_row_allowed(p_space_id text, p_bot_id text, p_helper_bot_id text, p_group_id text, p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off AS $$
  SELECT CASE WHEN NOT app_company_is_space(p_space_id) THEN true ELSE
    app_company_space_context_allowed(p_space_id, p_permission)
    AND (
      (p_bot_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM "bots" b WHERE b."id" = p_bot_id AND b."spaceId" = p_space_id
      ) AND app_company_bot_allowed(p_bot_id, p_permission))
      OR (p_helper_bot_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM "bots" b WHERE b."id" = p_helper_bot_id AND b."spaceId" = p_space_id
      ) AND app_company_bot_allowed(p_helper_bot_id, p_permission))
      OR (p_group_id IS NOT NULL AND app_company_group_allowed(p_group_id, p_permission))
    )
  END
$$;

-- Prisma also checks SELECT on the inserted thread's RETURNING row. Use its
-- row fields there rather than looking up the not-yet-visible thread by ID.
DROP POLICY threads_platform_bot_select ON "threads";
CREATE POLICY threads_platform_bot_select ON "threads" AS RESTRICTIVE FOR SELECT
  USING (app_company_thread_row_allowed("spaceId", "botId", "helperBotId", "groupId", 'use'));

-- Group and section INSERT ... RETURNING can run before an ID-based lookup sees
-- the new row. Existing rows still use the bounded all-members/all-bots checks.
CREATE OR REPLACE FUNCTION app_company_group_row_allowed(p_group_id text, p_space_id text, p_user_id text, p_permission text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off AS $$
DECLARE row_space text;
BEGIN
  IF app_rls_bypass() THEN RETURN true; END IF;
  IF NOT app_company_is_space(p_space_id) THEN RETURN true; END IF;
  IF NOT app_company_space_context_allowed(p_space_id, p_permission) THEN RETURN false; END IF;
  IF app_company_group_allowed(p_group_id, p_permission) THEN RETURN true; END IF;
  SELECT g."spaceId" INTO row_space FROM "chat_groups" g WHERE g."id" = p_group_id;
  IF row_space IS NOT NULL THEN RETURN false; END IF;
  RETURN p_user_id = NULLIF(current_setting('app.user_id', true), '');
END;
$$;

CREATE OR REPLACE FUNCTION app_company_section_row_allowed(p_section_id text, p_space_id text, p_user_id text, p_permission text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off AS $$
DECLARE row_space text;
BEGIN
  IF app_rls_bypass() THEN RETURN true; END IF;
  IF NOT app_company_is_space(p_space_id) THEN RETURN true; END IF;
  IF NOT app_company_space_context_allowed(p_space_id, p_permission) THEN RETURN false; END IF;
  IF app_company_section_allowed(p_section_id, p_permission) THEN RETURN true; END IF;
  SELECT s."spaceId" INTO row_space FROM "bot_sections" s WHERE s."id" = p_section_id;
  IF row_space IS NOT NULL THEN RETURN false; END IF;
  RETURN p_user_id = NULLIF(current_setting('app.user_id', true), '');
END;
$$;

DROP POLICY chat_groups_platform_bot_select ON "chat_groups";
CREATE POLICY chat_groups_platform_bot_select ON "chat_groups" AS RESTRICTIVE FOR SELECT
  USING (app_company_group_row_allowed("id", "spaceId", "userId", 'use'));
DROP POLICY chat_groups_platform_bot_insert ON "chat_groups";
CREATE POLICY chat_groups_platform_bot_insert ON "chat_groups" AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_company_space_context_allowed("spaceId", 'edit') AND
    (NOT app_company_is_space("spaceId") OR "userId" = NULLIF(current_setting('app.user_id', true), '')));

DROP POLICY bot_sections_platform_bot_select ON "bot_sections";
CREATE POLICY bot_sections_platform_bot_select ON "bot_sections" AS RESTRICTIVE FOR SELECT
  USING (app_company_section_row_allowed("id", "spaceId", "userId", 'use'));
DROP POLICY bot_sections_platform_bot_insert ON "bot_sections";
CREATE POLICY bot_sections_platform_bot_insert ON "bot_sections" AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_company_space_context_allowed("spaceId", 'edit') AND
    (NOT app_company_is_space("spaceId") OR "userId" = NULLIF(current_setting('app.user_id', true), '')));

-- Ticket INSERT ... RETURNING also checks SELECT before the generated ID can be
-- looked up. Evaluate access from the returned row's space and bot references.
CREATE OR REPLACE FUNCTION app_company_ticket_row_allowed(
  p_ticket_id text, p_space_id text, p_assignee_bot_id text, p_created_by_bot_id text, p_permission text
)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off AS $$
BEGIN
  IF app_rls_bypass() THEN RETURN true; END IF;
  IF NOT app_company_is_space(p_space_id) THEN RETURN true; END IF;
  IF NOT app_company_space_context_allowed(p_space_id, p_permission) THEN RETURN false; END IF;
  IF p_assignee_bot_id IS NOT NULL AND NOT app_company_bot_allowed(p_assignee_bot_id, p_permission) THEN RETURN false; END IF;
  IF p_created_by_bot_id IS NOT NULL AND NOT app_company_bot_allowed(p_created_by_bot_id, p_permission) THEN RETURN false; END IF;
  RETURN true;
END;
$$;

DROP POLICY tickets_platform_bot_fence ON "tickets";
CREATE POLICY tickets_platform_bot_fence ON "tickets" AS RESTRICTIVE FOR ALL
  USING (app_company_ticket_row_allowed("id", "spaceId", "assigneeBotId", "createdByBotId", 'use'))
  WITH CHECK (app_company_ticket_row_allowed("id", "spaceId", "assigneeBotId", "createdByBotId", 'edit'));

-- System-owned inbound mail must stay available to audited provider and maintenance jobs.
DROP POLICY bot_email_messages_owner_fence ON "bot_email_messages";
CREATE POLICY bot_email_messages_owner_fence ON "bot_email_messages" AS RESTRICTIVE FOR ALL USING (
  app_rls_bypass() OR (
    app_company_space_context_allowed("spaceId", 'use') AND EXISTS (
      SELECT 1 FROM "bots" b WHERE b."id" = "bot_email_messages"."botId"
        AND b."userId" = NULLIF(current_setting('app.user_id', true), '')
    )
  )
) WITH CHECK (
  app_rls_bypass() OR (
    app_company_space_context_allowed("spaceId", 'edit') AND EXISTS (
      SELECT 1 FROM "bots" b WHERE b."id" = "bot_email_messages"."botId"
        AND b."userId" = NULLIF(current_setting('app.user_id', true), '')
    )
  )
);

REVOKE ALL ON FUNCTION app_company_group_row_allowed(text, text, text, text),
  app_company_section_row_allowed(text, text, text, text),
  app_company_ticket_row_allowed(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_company_group_row_allowed(text, text, text, text),
  app_company_section_row_allowed(text, text, text, text),
  app_company_ticket_row_allowed(text, text, text, text, text) TO rakazo_app;
