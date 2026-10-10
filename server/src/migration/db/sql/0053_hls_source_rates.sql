ALTER TABLE `program_media_file` ADD `size_bytes` integer;--> statement-breakpoint
ALTER TABLE `program_media_file` ADD `duration` integer;--> statement-breakpoint
ALTER TABLE `program_media_stream` ADD `bitrate` integer;--> statement-breakpoint
ALTER TABLE `program_media_stream` ADD `statistics_bitrate` integer;--> statement-breakpoint
ALTER TABLE `program_media_stream` ADD `has_attached_picture` integer;--> statement-breakpoint
ALTER TABLE `program_version` ADD `bitrate` integer;--> statement-breakpoint
ALTER TABLE `program_version` ADD `container` text;