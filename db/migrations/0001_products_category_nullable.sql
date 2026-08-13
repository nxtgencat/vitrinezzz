PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_products` (
	`id` text PRIMARY KEY NOT NULL,
	`categoryId` text,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`hsnCode` text NOT NULL,
	`gstRatePct` integer NOT NULL,
	`isActive` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_products`("id", "categoryId", "name", "slug", "hsnCode", "gstRatePct", "isActive", "createdAt", "updatedAt") SELECT "id", "categoryId", "name", "slug", "hsnCode", "gstRatePct", "isActive", "createdAt", "updatedAt" FROM `products`;--> statement-breakpoint
DROP TABLE `products`;--> statement-breakpoint
ALTER TABLE `__new_products` RENAME TO `products`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `products_slug_unique` ON `products` (`slug`);--> statement-breakpoint
CREATE INDEX `products_category_id_idx` ON `products` (`categoryId`);