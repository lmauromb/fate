BEGIN;

CREATE TABLE IF NOT EXISTS "verification" (
  "id" TEXT NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification"("identifier");

ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "impersonatedBy" TEXT;

-- Better Auth 1.7.3 restored providerId/accountId as the account identity.
CREATE UNIQUE INDEX IF NOT EXISTS "account_providerId_accountId_key" ON "account"("providerId", "accountId");
DROP INDEX IF EXISTS "account_issuer_accountId_key";
ALTER TABLE "account" DROP COLUMN IF EXISTS "issuer";

COMMIT;
