CREATE TABLE `files_favorites` (
	`userId` bigint unsigned NOT NULL,
	`fileId` bigint unsigned NOT NULL,
	`createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `files_favorites_userId_fileId_pk` PRIMARY KEY(`userId`,`fileId`)
);
--> statement-breakpoint
CREATE TABLE `nc_sync_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`ownerId` bigint unsigned NOT NULL,
	`repository` varchar(16) NOT NULL,
	`spaceAlias` varchar(64) NOT NULL,
	`path` varchar(4096) NOT NULL,
	`type` enum('create','update','delete') NOT NULL,
	`ts` bigint unsigned NOT NULL,
	CONSTRAINT `nc_sync_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `files_favorites` ADD CONSTRAINT `files_favorites_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `files_favorites` ADD CONSTRAINT `files_favorites_fileId_files_id_fk` FOREIGN KEY (`fileId`) REFERENCES `files`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `nc_sync_events` ADD CONSTRAINT `nc_sync_events_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `user_idx` ON `files_favorites` (`userId`);--> statement-breakpoint
CREATE INDEX `file_idx` ON `files_favorites` (`fileId`);--> statement-breakpoint
CREATE INDEX `owner_id_idx` ON `nc_sync_events` (`ownerId`,`id`);--> statement-breakpoint
CREATE INDEX `owner_space_id_idx` ON `nc_sync_events` (`ownerId`,`spaceAlias`,`id`);--> statement-breakpoint
CREATE INDEX `ts_idx` ON `nc_sync_events` (`ts`);