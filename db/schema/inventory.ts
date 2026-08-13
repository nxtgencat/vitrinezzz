import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { batches, variants } from "./catalog";
import { outlets } from "./org";

export const stockLevels = sqliteTable(
  "stock_levels",
  {
    variantId: text("variantId").references(() => variants.id, { onDelete: "restrict" }).notNull(),
    outletId: text("outletId").references(() => outlets.id, { onDelete: "restrict" }).notNull(),
    batchId: text("batchId").references(() => batches.id, { onDelete: "restrict" }).notNull(),
    quantity: integer("quantity").notNull(),
    lastMovementId: text("lastMovementId").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [primaryKey({ columns: [t.variantId, t.outletId, t.batchId] })],
);

export const stockMovements = sqliteTable(
  "stock_movements",
  {
    id: text("id").primaryKey(),
    variantId: text("variantId").references(() => variants.id, { onDelete: "restrict" }).notNull(),
    outletId: text("outletId").references(() => outlets.id, { onDelete: "restrict" }).notNull(),
    batchId: text("batchId").references(() => batches.id, { onDelete: "restrict" }).notNull(),
    delta: integer("delta").notNull(),
    reason: text("reason").notNull(),
    sourceType: text("sourceType").notNull(),
    sourceId: text("sourceId"),
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [
    index("stock_movements_variant_outlet_idx").on(t.variantId, t.outletId),
    index("stock_movements_source_idx").on(t.sourceType, t.sourceId),
  ],
);

export const stockTransfers = sqliteTable(
  "stock_transfers",
  {
    id: text("id").primaryKey(),
    transferNumber: text("transferNumber").notNull(),
    fromOutletId: text("fromOutletId").references(() => outlets.id, { onDelete: "restrict" }).notNull(),
    toOutletId: text("toOutletId").references(() => outlets.id, { onDelete: "restrict" }).notNull(),
    status: text("status").notNull(),
    version: integer("version").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [uniqueIndex("stock_transfers_transfer_number_unique").on(t.transferNumber)],
);

export const stockTransferItems = sqliteTable(
  "stock_transfer_items",
  {
    id: text("id").primaryKey(),
    stockTransferId: text("stockTransferId").references(() => stockTransfers.id, { onDelete: "cascade" }).notNull(),
    variantId: text("variantId").references(() => variants.id, { onDelete: "restrict" }).notNull(),
    batchId: text("batchId").references(() => batches.id, { onDelete: "restrict" }).notNull(),
    quantity: integer("quantity").notNull(),
  },
  (t) => [index("stock_transfer_items_transfer_idx").on(t.stockTransferId)],
);

export const adjustments = sqliteTable(
  "adjustments",
  {
    id: text("id").primaryKey(),
    adjustmentNumber: text("adjustmentNumber").notNull(),
    outletId: text("outletId").references(() => outlets.id, { onDelete: "restrict" }).notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull(),
    version: integer("version").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [uniqueIndex("adjustments_adjustment_number_unique").on(t.adjustmentNumber)],
);

export const adjustmentItems = sqliteTable(
  "adjustment_items",
  {
    id: text("id").primaryKey(),
    adjustmentId: text("adjustmentId").references(() => adjustments.id, { onDelete: "cascade" }).notNull(),
    variantId: text("variantId").references(() => variants.id, { onDelete: "restrict" }).notNull(),
    batchId: text("batchId").references(() => batches.id, { onDelete: "restrict" }).notNull(),
    quantity: integer("quantity").notNull(),
    unitValuePaise: integer("unitValuePaise").notNull(),
  },
  (t) => [index("adjustment_items_adjustment_idx").on(t.adjustmentId)],
);
