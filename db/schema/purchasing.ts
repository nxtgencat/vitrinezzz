import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { batches, variants, vendors } from "./catalog";
import { outlets } from "./org";

export const purchaseBills = sqliteTable(
  "purchase_bills",
  {
    id: text("id").primaryKey(),
    billNumber: text("billNumber").notNull(),
    vendorId: text("vendorId").references(() => vendors.id, { onDelete: "restrict" }).notNull(),
    outletId: text("outletId").references(() => outlets.id, { onDelete: "restrict" }).notNull(),
    status: text("status").notNull(),
    subtotalPaise: integer("subtotalPaise").notNull(),
    taxPaise: integer("taxPaise").notNull(),
    totalPaise: integer("totalPaise").notNull(),
    version: integer("version").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [uniqueIndex("purchase_bills_bill_number_unique").on(t.billNumber)],
);

export const purchaseBillItems = sqliteTable(
  "purchase_bill_items",
  {
    id: text("id").primaryKey(),
    purchaseBillId: text("purchaseBillId").references(() => purchaseBills.id, { onDelete: "cascade" }).notNull(),
    variantId: text("variantId").references(() => variants.id, { onDelete: "restrict" }).notNull(),
    batchId: text("batchId").references(() => batches.id, { onDelete: "restrict" }),
    batchNumber: text("batchNumber"),
    quantity: integer("quantity").notNull(),
    unitCostPaise: integer("unitCostPaise").notNull(),
    taxRatePct: integer("taxRatePct").notNull(),
    taxAmountPaise: integer("taxAmountPaise").notNull(),
    lineTotalPaise: integer("lineTotalPaise").notNull(),
  },
  (t) => [index("purchase_bill_items_bill_idx").on(t.purchaseBillId)],
);

export const billCharges = sqliteTable(
  "bill_charges",
  {
    id: text("id").primaryKey(),
    purchaseBillId: text("purchaseBillId").references(() => purchaseBills.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    amountPaise: integer("amountPaise").notNull(),
  },
  (t) => [index("bill_charges_bill_idx").on(t.purchaseBillId)],
);
