CREATE TABLE `friends` (
	`owner_user` text NOT NULL,
	`friend_user` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner_user`, `friend_user`),
	FOREIGN KEY (`owner_user`) REFERENCES `players`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`friend_user`) REFERENCES `players`(`user_id`) ON UPDATE no action ON DELETE no action
);
