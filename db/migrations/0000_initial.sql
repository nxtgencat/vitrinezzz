CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`idToken` text,
	`password` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_provider_account_unique` ON `account` (`providerId`,`accountId`);--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`userId`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`token` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`userId`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer NOT NULL,
	`image` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cart_items` (
	`id` text PRIMARY KEY NOT NULL,
	`customerId` text NOT NULL,
	`variantId` text NOT NULL,
	`quantity` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`variantId`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cart_items_customer_variant_unique` ON `cart_items` (`customerId`,`variantId`);--> statement-breakpoint
CREATE TABLE `wishlist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`customerId` text NOT NULL,
	`variantId` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`variantId`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wishlist_items_customer_variant_unique` ON `wishlist_items` (`customerId`,`variantId`);--> statement-breakpoint
CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`variantId` text NOT NULL,
	`batchNumber` text NOT NULL,
	`expiryDate` integer,
	`costPricePaise` integer NOT NULL,
	`isActive` integer NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`variantId`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `batches_variant_id_batch_number_unique` ON `batches` (`variantId`,`batchNumber`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parentId` text,
	`isActive` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`parentId`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `categories_parent_id_idx` ON `categories` (`parentId`);--> statement-breakpoint
CREATE TABLE `cust_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`customerId` text NOT NULL,
	`label` text NOT NULL,
	`line1` text NOT NULL,
	`line2` text,
	`city` text NOT NULL,
	`state` text NOT NULL,
	`pincode` text NOT NULL,
	FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cust_addresses_customer_id_idx` ON `cust_addresses` (`customerId`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text,
	`name` text NOT NULL,
	`phone` text,
	`gstin` text,
	`isActive` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_user_id_unique` ON `customers` (`userId`) WHERE "customers"."userId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `customers_phone_unique` ON `customers` (`phone`) WHERE "customers"."phone" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`categoryId` text NOT NULL,
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
CREATE UNIQUE INDEX `products_slug_unique` ON `products` (`slug`);--> statement-breakpoint
CREATE INDEX `products_category_id_idx` ON `products` (`categoryId`);--> statement-breakpoint
CREATE TABLE `variants` (
	`id` text PRIMARY KEY NOT NULL,
	`productId` text NOT NULL,
	`name` text NOT NULL,
	`sku` text,
	`barcode` text,
	`costPricePaise` integer NOT NULL,
	`sellingPricePaise` integer NOT NULL,
	`mrpPaise` integer NOT NULL,
	`isBase` integer NOT NULL,
	`isTaxable` integer NOT NULL,
	`isCustomerVisible` integer NOT NULL,
	`isActive` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variants_sku_unique` ON `variants` (`sku`) WHERE "variants"."sku" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `variants_barcode_unique` ON `variants` (`barcode`) WHERE "variants"."barcode" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `variants_product_id_is_base_unique` ON `variants` (`productId`) WHERE "variants"."isBase" = 1;--> statement-breakpoint
CREATE INDEX `variants_product_id_idx` ON `variants` (`productId`);--> statement-breakpoint
CREATE TABLE `vendors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`gstin` text,
	`isActive` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`entityType` text NOT NULL,
	`entityId` text NOT NULL,
	`action` text NOT NULL,
	`actorId` text NOT NULL,
	`actorType` text NOT NULL,
	`before` text,
	`after` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_entity_idx` ON `audit_events` (`entityType`,`entityId`);--> statement-breakpoint
CREATE INDEX `audit_events_actor_idx` ON `audit_events` (`actorId`);--> statement-breakpoint
CREATE TABLE `order_events` (
	`id` text PRIMARY KEY NOT NULL,
	`orderId` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`actorId` text,
	`actorType` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `order_events_order_idx` ON `order_events` (`orderId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `adjustment_items` (
	`id` text PRIMARY KEY NOT NULL,
	`adjustmentId` text NOT NULL,
	`variantId` text NOT NULL,
	`batchId` text NOT NULL,
	`quantity` integer NOT NULL,
	`unitValuePaise` integer NOT NULL,
	FOREIGN KEY (`adjustmentId`) REFERENCES `adjustments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variantId`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`batchId`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `adjustment_items_adjustment_idx` ON `adjustment_items` (`adjustmentId`);--> statement-breakpoint
CREATE TABLE `adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`adjustmentNumber` text NOT NULL,
	`outletId` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`outletId`) REFERENCES `outlets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `adjustments_adjustment_number_unique` ON `adjustments` (`adjustmentNumber`);--> statement-breakpoint
CREATE TABLE `stock_levels` (
	`variantId` text NOT NULL,
	`outletId` text NOT NULL,
	`batchId` text NOT NULL,
	`quantity` integer NOT NULL,
	`lastMovementId` text NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`variantId`, `outletId`, `batchId`),
	FOREIGN KEY (`variantId`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`outletId`) REFERENCES `outlets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`batchId`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `stock_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`variantId` text NOT NULL,
	`outletId` text NOT NULL,
	`batchId` text NOT NULL,
	`delta` integer NOT NULL,
	`reason` text NOT NULL,
	`sourceType` text NOT NULL,
	`sourceId` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`variantId`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`outletId`) REFERENCES `outlets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`batchId`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `stock_movements_variant_outlet_idx` ON `stock_movements` (`variantId`,`outletId`);--> statement-breakpoint
CREATE INDEX `stock_movements_source_idx` ON `stock_movements` (`sourceType`,`sourceId`);--> statement-breakpoint
CREATE TABLE `stock_transfer_items` (
	`id` text PRIMARY KEY NOT NULL,
	`stockTransferId` text NOT NULL,
	`variantId` text NOT NULL,
	`batchId` text NOT NULL,
	`quantity` integer NOT NULL,
	FOREIGN KEY (`stockTransferId`) REFERENCES `stock_transfers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variantId`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`batchId`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `stock_transfer_items_transfer_idx` ON `stock_transfer_items` (`stockTransferId`);--> statement-breakpoint
CREATE TABLE `stock_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`transferNumber` text NOT NULL,
	`fromOutletId` text NOT NULL,
	`toOutletId` text NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`fromOutletId`) REFERENCES `outlets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`toOutletId`) REFERENCES `outlets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_transfers_transfer_number_unique` ON `stock_transfers` (`transferNumber`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerType` text NOT NULL,
	`ownerId` text NOT NULL,
	`path` text NOT NULL,
	`thumbPath` text,
	`mimeType` text NOT NULL,
	`sizeBytes` integer NOT NULL,
	`altText` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `media_owner_idx` ON `media` (`ownerType`,`ownerId`);--> statement-breakpoint
CREATE TABLE `invoice_charges` (
	`id` text PRIMARY KEY NOT NULL,
	`invoiceId` text NOT NULL,
	`name` text NOT NULL,
	`amountPaise` integer NOT NULL,
	FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invoice_charges_invoice_idx` ON `invoice_charges` (`invoiceId`);--> statement-breakpoint
CREATE TABLE `invoice_items` (
	`id` text PRIMARY KEY NOT NULL,
	`invoiceId` text NOT NULL,
	`variantId` text,
	`name` text NOT NULL,
	`quantity` integer NOT NULL,
	`unitPricePaise` integer NOT NULL,
	`taxRatePct` integer NOT NULL,
	`taxAmountPaise` integer NOT NULL,
	`lineTotalPaise` integer NOT NULL,
	`isCustomItem` integer NOT NULL,
	`allocations` text NOT NULL,
	FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variantId`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `invoice_items_invoice_idx` ON `invoice_items` (`invoiceId`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`invoiceNumber` text NOT NULL,
	`orderId` text,
	`customerId` text,
	`outletId` text NOT NULL,
	`status` text NOT NULL,
	`subtotalPaise` integer NOT NULL,
	`taxPaise` integer NOT NULL,
	`totalPaise` integer NOT NULL,
	`pdfPath` text,
	`supersedesId` text,
	`version` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`outletId`) REFERENCES `outlets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`supersedesId`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_invoice_number_unique` ON `invoices` (`invoiceNumber`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`orderNumber` text NOT NULL,
	`orderType` text NOT NULL,
	`customerId` text,
	`outletId` text NOT NULL,
	`status` text NOT NULL,
	`totalPaise` integer NOT NULL,
	`version` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`outletId`) REFERENCES `outlets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_order_number_unique` ON `orders` (`orderNumber`);--> statement-breakpoint
CREATE TABLE `return_items` (
	`id` text PRIMARY KEY NOT NULL,
	`returnId` text NOT NULL,
	`variantId` text NOT NULL,
	`originalItemId` text NOT NULL,
	`quantity` integer NOT NULL,
	`unitPricePaise` integer NOT NULL,
	`taxAmountPaise` integer NOT NULL,
	FOREIGN KEY (`returnId`) REFERENCES `returns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variantId`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `return_items_return_idx` ON `return_items` (`returnId`);--> statement-breakpoint
CREATE TABLE `returns` (
	`id` text PRIMARY KEY NOT NULL,
	`returnNumber` text NOT NULL,
	`returnType` text NOT NULL,
	`orderId` text,
	`purchaseBillId` text,
	`outletId` text NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`purchaseBillId`) REFERENCES `purchase_bills`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`outletId`) REFERENCES `outlets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `returns_return_number_unique` ON `returns` (`returnNumber`);--> statement-breakpoint
CREATE TABLE `shipments` (
	`id` text PRIMARY KEY NOT NULL,
	`shipmentNumber` text NOT NULL,
	`invoiceId` text NOT NULL,
	`carrier` text NOT NULL,
	`awbNumber` text,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shipments_shipment_number_unique` ON `shipments` (`shipmentNumber`);--> statement-breakpoint
CREATE INDEX `shipments_invoice_idx` ON `shipments` (`invoiceId`);--> statement-breakpoint
CREATE TABLE `outlets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`isActive` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`capabilities` text NOT NULL,
	`scope` text NOT NULL,
	`outletId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`outletId`) REFERENCES `outlets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_name_unique` ON `roles` (`name`);--> statement-breakpoint
CREATE INDEX `roles_scope_idx` ON `roles` (`scope`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`orgName` text NOT NULL,
	`gstin` text,
	`fiscalYearStartMonth` integer NOT NULL,
	`currency` text NOT NULL,
	`timezone` text NOT NULL,
	`defaultOutletId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`defaultOutletId`) REFERENCES `outlets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `staff_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`outletId` text NOT NULL,
	`roleId` text NOT NULL,
	`phone` text,
	`isActive` integer NOT NULL,
	`isProtected` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`outletId`) REFERENCES `outlets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_profiles_user_id_unique` ON `staff_profiles` (`userId`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`paymentNumber` text NOT NULL,
	`direction` text NOT NULL,
	`partyType` text NOT NULL,
	`partyId` text NOT NULL,
	`invoiceId` text,
	`purchaseBillId` text,
	`returnId` text,
	`outletId` text NOT NULL,
	`amountPaise` integer NOT NULL,
	`mode` text NOT NULL,
	`gateway` text,
	`gatewayPaymentId` text,
	`gatewayEventId` text,
	`status` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`purchaseBillId`) REFERENCES `purchase_bills`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`returnId`) REFERENCES `returns`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`outletId`) REFERENCES `outlets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_payment_number_unique` ON `payments` (`paymentNumber`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_gateway_event_unique` ON `payments` (`gateway`,`gatewayEventId`) WHERE "payments"."gateway" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `payments_party_idx` ON `payments` (`partyType`,`partyId`);--> statement-breakpoint
CREATE INDEX `payments_invoice_idx` ON `payments` (`invoiceId`);--> statement-breakpoint
CREATE INDEX `payments_purchase_bill_idx` ON `payments` (`purchaseBillId`);--> statement-breakpoint
CREATE TABLE `bill_charges` (
	`id` text PRIMARY KEY NOT NULL,
	`purchaseBillId` text NOT NULL,
	`name` text NOT NULL,
	`amountPaise` integer NOT NULL,
	FOREIGN KEY (`purchaseBillId`) REFERENCES `purchase_bills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bill_charges_bill_idx` ON `bill_charges` (`purchaseBillId`);--> statement-breakpoint
CREATE TABLE `purchase_bill_items` (
	`id` text PRIMARY KEY NOT NULL,
	`purchaseBillId` text NOT NULL,
	`variantId` text NOT NULL,
	`batchId` text,
	`batchNumber` text,
	`quantity` integer NOT NULL,
	`unitCostPaise` integer NOT NULL,
	`taxRatePct` integer NOT NULL,
	`taxAmountPaise` integer NOT NULL,
	`lineTotalPaise` integer NOT NULL,
	FOREIGN KEY (`purchaseBillId`) REFERENCES `purchase_bills`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variantId`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`batchId`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `purchase_bill_items_bill_idx` ON `purchase_bill_items` (`purchaseBillId`);--> statement-breakpoint
CREATE TABLE `purchase_bills` (
	`id` text PRIMARY KEY NOT NULL,
	`billNumber` text NOT NULL,
	`vendorId` text NOT NULL,
	`outletId` text NOT NULL,
	`status` text NOT NULL,
	`subtotalPaise` integer NOT NULL,
	`taxPaise` integer NOT NULL,
	`totalPaise` integer NOT NULL,
	`version` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`vendorId`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`outletId`) REFERENCES `outlets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_bills_bill_number_unique` ON `purchase_bills` (`billNumber`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`key` text NOT NULL,
	`requestHash` text NOT NULL,
	`responseSnapshot` text NOT NULL,
	`status` text NOT NULL,
	`createdAt` integer NOT NULL,
	`expiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_keys_operation_key_unique` ON `idempotency_keys` (`operation`,`key`);--> statement-breakpoint
CREATE INDEX `idempotency_keys_expires_idx` ON `idempotency_keys` (`expiresAt`);--> statement-breakpoint
CREATE TRIGGER `stock_movements_immutable_update` BEFORE UPDATE ON `stock_movements` BEGIN SELECT RAISE(ABORT, 'stock_movements is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `stock_movements_immutable_delete` BEFORE DELETE ON `stock_movements` BEGIN SELECT RAISE(ABORT, 'stock_movements is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `payments_immutable_update` BEFORE UPDATE ON `payments` BEGIN SELECT RAISE(ABORT, 'payments is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `payments_immutable_delete` BEFORE DELETE ON `payments` BEGIN SELECT RAISE(ABORT, 'payments is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `order_events_immutable_update` BEFORE UPDATE ON `order_events` BEGIN SELECT RAISE(ABORT, 'order_events is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `order_events_immutable_delete` BEFORE DELETE ON `order_events` BEGIN SELECT RAISE(ABORT, 'order_events is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `audit_events_immutable_update` BEFORE UPDATE ON `audit_events` BEGIN SELECT RAISE(ABORT, 'audit_events is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `audit_events_immutable_delete` BEFORE DELETE ON `audit_events` BEGIN SELECT RAISE(ABORT, 'audit_events is immutable'); END;