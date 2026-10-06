CREATE TABLE `accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`nickname_key` text NOT NULL,
	`password_hash` text NOT NULL,
	`chatgpt_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_nickname` ON `accounts` (`nickname_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_chatgpt` ON `accounts` (`chatgpt_id`);--> statement-breakpoint
CREATE TABLE `auth_intents` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`user_id` text,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `account_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`version` integer NOT NULL,
	`method` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_user` ON `account_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expiry` ON `account_sessions` (`expires_at`);