CREATE TABLE `custom_files_favorites` (
	`userId` bigint unsigned NOT NULL,
	`fileId` bigint unsigned NOT NULL,
	`createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `custom_files_favorites_userId_fileId_pk` PRIMARY KEY(`userId`,`fileId`)
);
--> statement-breakpoint
ALTER TABLE `custom_files_favorites` ADD CONSTRAINT `custom_files_favorites_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `custom_files_favorites` ADD CONSTRAINT `custom_files_favorites_fileId_files_id_fk` FOREIGN KEY (`fileId`) REFERENCES `files`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `custom_files_favorites_user_idx` ON `custom_files_favorites` (`userId`);--> statement-breakpoint
CREATE INDEX `custom_files_favorites_file_idx` ON `custom_files_favorites` (`fileId`);