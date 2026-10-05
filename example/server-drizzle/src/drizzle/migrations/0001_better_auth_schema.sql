CREATE TABLE "verification" (
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
DROP INDEX "account_issuer_accountId_key";--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "impersonatedBy" text;--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "account_providerId_accountId_key" ON "account" USING btree ("providerId","accountId");--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "issuer";