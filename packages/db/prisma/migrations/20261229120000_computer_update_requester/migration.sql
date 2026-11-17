ALTER TABLE "computer_updates"
  ADD COLUMN IF NOT EXISTS "requestedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "failureReason" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'computer_updates_requestedByUserId_fkey'
      AND conrelid = 'computer_updates'::regclass
  ) THEN
    ALTER TABLE "computer_updates"
      ADD CONSTRAINT "computer_updates_requestedByUserId_fkey"
      FOREIGN KEY ("requestedByUserId") REFERENCES "user"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "computer_updates_requestedByUserId_idx"
  ON "computer_updates"("requestedByUserId");
