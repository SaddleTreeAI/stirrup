CREATE TABLE "platform_model_budget_alerts" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "monthStart" TIMESTAMP(3) NOT NULL,
  "thresholdPercent" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3),
  CONSTRAINT "platform_model_budget_alerts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_model_budget_alerts_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "platform_model_budget_alerts_threshold_valid"
    CHECK ("thresholdPercent" IN (80, 100))
);
CREATE UNIQUE INDEX "platform_model_budget_alerts_userId_monthStart_thresholdPercent_key"
  ON "platform_model_budget_alerts"("userId", "monthStart", "thresholdPercent");
CREATE INDEX "platform_model_budget_alerts_delivery_idx"
  ON "platform_model_budget_alerts"("sentAt", "createdAt");
ALTER TABLE "platform_model_budget_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_model_budget_alerts" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_model_budget_alerts_system ON "platform_model_budget_alerts"
  USING ((SELECT app_rls_bypass())) WITH CHECK ((SELECT app_rls_bypass()));
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_model_budget_alerts" TO rakazo_app;
