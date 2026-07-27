CREATE TABLE `custom_files_versions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`fileId` bigint unsigned NOT NULL,
	`ownerId` bigint unsigned,
	`spaceId` bigint unsigned,
	`spaceExternalRootId` bigint unsigned,
	`shareExternalId` bigint unsigned,
	`versionsRoot` varchar(261) NOT NULL,
	`checksum` char(64) NOT NULL,
	`size` bigint unsigned NOT NULL,
	`mtime` bigint unsigned NOT NULL,
	`createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`authorId` bigint unsigned,
	`origin` enum('web','web-patch','webdav','sync','sync-make','nc-chunked','nc-text','collabora','onlyoffice','restore') NOT NULL,
	`label` varchar(255),
	CONSTRAINT `custom_files_versions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `custom_files_versions` ADD CONSTRAINT `custom_files_versions_fileId_files_id_fk` FOREIGN KEY (`fileId`) REFERENCES `files`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `custom_files_versions` ADD CONSTRAINT `custom_files_versions_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `custom_files_versions` ADD CONSTRAINT `custom_files_versions_spaceId_spaces_id_fk` FOREIGN KEY (`spaceId`) REFERENCES `spaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `custom_files_versions` ADD CONSTRAINT `custom_files_versions_spaceExternalRootId_spaces_roots_id_fk` FOREIGN KEY (`spaceExternalRootId`) REFERENCES `spaces_roots`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `custom_files_versions` ADD CONSTRAINT `custom_files_versions_shareExternalId_shares_id_fk` FOREIGN KEY (`shareExternalId`) REFERENCES `shares`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `custom_files_versions` ADD CONSTRAINT `custom_files_versions_authorId_users_id_fk` FOREIGN KEY (`authorId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `custom_files_versions_file_idx` ON `custom_files_versions` (`fileId`);--> statement-breakpoint
CREATE INDEX `custom_files_versions_blob_idx` ON `custom_files_versions` (`checksum`,`versionsRoot`);--> statement-breakpoint
CREATE INDEX `custom_files_versions_created_idx` ON `custom_files_versions` (`createdAt`);--> statement-breakpoint
CREATE INDEX `custom_files_versions_coalesce_idx` ON `custom_files_versions` (`fileId`,`authorId`,`origin`,`createdAt`);--> statement-breakpoint
CREATE INDEX `custom_files_versions_root_idx` ON `custom_files_versions` (`versionsRoot`,`label`,`createdAt`);