CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user` text NOT NULL,
	`guest_user` text,
	`target_user` text,
	`status` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`state_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `games_owner_updated` ON `games` (`owner_user`,`updated_at`);--> statement-breakpoint
CREATE INDEX `games_guest_updated` ON `games` (`guest_user`,`updated_at`);--> statement-breakpoint
CREATE INDEX `games_target_status` ON `games` (`target_user`,`status`);--> statement-breakpoint
CREATE TABLE `players` (
	`user_id` text PRIMARY KEY NOT NULL,
	`nickname` text NOT NULL,
	`friend_code` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `players_friend_code` ON `players` (`friend_code`);