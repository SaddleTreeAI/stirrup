ALTER TABLE "user" ADD COLUMN "platformRole" TEXT NOT NULL DEFAULT 'member';
ALTER TABLE "user" ADD COLUMN "platformMonthlyBudgetMicros" BIGINT NOT NULL DEFAULT 100000000;
ALTER TABLE "user" ADD COLUMN "platformMonitoringAcceptedAt" TIMESTAMP(3);
ALTER TABLE "user" ADD CONSTRAINT "user_platformMonthlyBudgetMicros_nonnegative"
  CHECK ("platformMonthlyBudgetMicros" >= 0);
ALTER TABLE "user" ADD CONSTRAINT "user_platformRole_valid"
  CHECK ("platformRole" IN ('owner', 'admin', 'member'));

ALTER TABLE "deployment_settings" ADD COLUMN "platformMode" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "platform_invites" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "tokenHash" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_invites_tokenHash_key" ON "platform_invites"("tokenHash");
CREATE INDEX "platform_invites_email_createdAt_idx" ON "platform_invites"("email", "createdAt");
CREATE INDEX "platform_invites_expiresAt_idx" ON "platform_invites"("expiresAt");
ALTER TABLE "platform_invites" ADD CONSTRAINT "platform_invites_role_valid"
  CHECK ("role" IN ('admin', 'member'));
CREATE INDEX "usage_records_createdAt_userId_idx" ON "usage_records"("createdAt", "userId");
