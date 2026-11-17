CREATE TABLE "platform_model_connections" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "secretId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_model_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_model_connections_secretId_fkey" FOREIGN KEY ("secretId")
    REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "platform_model_connections_provider_key" ON "platform_model_connections"("provider");
CREATE UNIQUE INDEX "platform_model_connections_secretId_key" ON "platform_model_connections"("secretId");
CREATE INDEX "platform_model_connections_enabled_provider_idx" ON "platform_model_connections"("enabled", "provider");
ALTER TABLE "platform_model_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_model_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_model_connections_system ON "platform_model_connections"
  USING ((SELECT app_rls_bypass())) WITH CHECK ((SELECT app_rls_bypass()));

CREATE TABLE "platform_model_grants" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "allowedModelIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "countsTowardUserBudget" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_model_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_model_grants_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "platform_model_grants_connectionId_fkey" FOREIGN KEY ("connectionId")
    REFERENCES "platform_model_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "platform_model_grants_userId_connectionId_key" ON "platform_model_grants"("userId", "connectionId");
CREATE INDEX "platform_model_grants_userId_enabled_idx" ON "platform_model_grants"("userId", "enabled");
ALTER TABLE "platform_model_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_model_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_model_grants_system ON "platform_model_grants"
  USING ((SELECT app_rls_bypass())) WITH CHECK ((SELECT app_rls_bypass()));

CREATE TABLE "platform_model_budget_buckets" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "monthStart" TIMESTAMP(3) NOT NULL,
  "reservedMicros" BIGINT NOT NULL DEFAULT 0,
  "chargedMicros" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_model_budget_buckets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_model_budget_buckets_nonnegative" CHECK ("reservedMicros" >= 0 AND "chargedMicros" >= 0)
);
CREATE UNIQUE INDEX "platform_model_budget_buckets_userId_monthStart_key" ON "platform_model_budget_buckets"("userId", "monthStart");
ALTER TABLE "platform_model_budget_buckets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_model_budget_buckets" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_model_budget_buckets_system ON "platform_model_budget_buckets"
  USING ((SELECT app_rls_bypass())) WITH CHECK ((SELECT app_rls_bypass()));

CREATE TABLE "platform_model_calls" (
  "id" TEXT NOT NULL,
  "callId" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT,
  "runId" TEXT,
  "botId" TEXT,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "monthStart" TIMESTAMP(3),
  "budgeted" BOOLEAN NOT NULL DEFAULT false,
  "reservedMicros" BIGINT NOT NULL DEFAULT 0,
  "actualMicros" BIGINT,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "providerRequestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "platform_model_calls_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_model_calls_state_valid" CHECK ("state" IN ('pending', 'settled', 'released', 'unknown')),
  CONSTRAINT "platform_model_calls_amounts_nonnegative" CHECK ("reservedMicros" >= 0 AND ("actualMicros" IS NULL OR "actualMicros" >= 0))
);
CREATE UNIQUE INDEX "platform_model_calls_callId_key" ON "platform_model_calls"("callId");
CREATE INDEX "platform_model_calls_userId_createdAt_idx" ON "platform_model_calls"("userId", "createdAt");
CREATE INDEX "platform_model_calls_grantId_createdAt_idx" ON "platform_model_calls"("grantId", "createdAt");
CREATE INDEX "platform_model_calls_state_createdAt_idx" ON "platform_model_calls"("state", "createdAt");
ALTER TABLE "platform_model_calls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_model_calls" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_model_calls_system ON "platform_model_calls"
  USING ((SELECT app_rls_bypass())) WITH CHECK ((SELECT app_rls_bypass()));

ALTER TABLE "deployment_settings" ADD COLUMN "companySpaceId" TEXT;
CREATE UNIQUE INDEX "deployment_settings_companySpaceId_key" ON "deployment_settings"("companySpaceId");
ALTER TABLE "deployment_settings" ADD CONSTRAINT "deployment_settings_companySpaceId_fkey"
  FOREIGN KEY ("companySpaceId") REFERENCES "spaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "platform_bot_grants" (
  "id" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "permission" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_bot_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_bot_grants_permission_valid" CHECK ("permission" IN ('use', 'edit', 'manage')),
  CONSTRAINT "platform_bot_grants_botId_fkey" FOREIGN KEY ("botId")
    REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "platform_bot_grants_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "platform_bot_grants_botId_userId_key" ON "platform_bot_grants"("botId", "userId");
CREATE INDEX "platform_bot_grants_userId_idx" ON "platform_bot_grants"("userId");
CREATE INDEX "platform_bot_grants_botId_idx" ON "platform_bot_grants"("botId");
ALTER TABLE "platform_bot_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_bot_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_bot_grants_system ON "platform_bot_grants"
  USING ((SELECT app_rls_bypass())) WITH CHECK ((SELECT app_rls_bypass()));

GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_model_connections", "platform_model_grants",
  "platform_model_budget_buckets", "platform_model_calls", "platform_bot_grants",
  "deployment_settings" TO rakazo_app;
