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
