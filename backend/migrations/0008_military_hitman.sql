ALTER TABLE `custom_files_versions` DROP FOREIGN KEY `custom_files_versions_ownerId_users_id_fk`;
--> statement-breakpoint
ALTER TABLE `custom_files_versions` DROP FOREIGN KEY `custom_files_versions_spaceId_spaces_id_fk`;
--> statement-breakpoint
ALTER TABLE `custom_files_versions` DROP FOREIGN KEY `custom_files_versions_spaceExternalRootId_spaces_roots_id_fk`;
--> statement-breakpoint
ALTER TABLE `custom_files_versions` DROP FOREIGN KEY `custom_files_versions_shareExternalId_shares_id_fk`;
--> statement-breakpoint
ALTER TABLE `custom_files_versions` ADD CONSTRAINT `custom_files_versions_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `custom_files_versions` ADD CONSTRAINT `custom_files_versions_spaceId_spaces_id_fk` FOREIGN KEY (`spaceId`) REFERENCES `spaces`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `custom_files_versions` ADD CONSTRAINT `custom_files_versions_spaceExternalRootId_spaces_roots_id_fk` FOREIGN KEY (`spaceExternalRootId`) REFERENCES `spaces_roots`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `custom_files_versions` ADD CONSTRAINT `custom_files_versions_shareExternalId_shares_id_fk` FOREIGN KEY (`shareExternalId`) REFERENCES `shares`(`id`) ON DELETE set null ON UPDATE no action;