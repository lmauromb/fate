CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
ALTER TABLE `session` ADD COLUMN `impersonatedBy` text;
--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`userId`);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`userId`);
