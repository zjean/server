ALTER TABLE `custom_files_favorites` ADD `path` varchar(4096) NOT NULL;--> statement-breakpoint
ALTER TABLE `custom_files_favorites` ADD `spaceId` bigint unsigned;--> statement-breakpoint
ALTER TABLE `custom_files_favorites` ADD `shareId` bigint unsigned;--> statement-breakpoint
ALTER TABLE `custom_files_favorites` ADD CONSTRAINT `custom_files_favorites_spaceId_spaces_id_fk` FOREIGN KEY (`spaceId`) REFERENCES `spaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `custom_files_favorites` ADD CONSTRAINT `custom_files_favorites_shareId_shares_id_fk` FOREIGN KEY (`shareId`) REFERENCES `shares`(`id`) ON DELETE cascade ON UPDATE no action;