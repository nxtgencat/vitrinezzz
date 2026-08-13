import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { customers, variants } from "./catalog";
import { outlets } from "./org";
import { purchaseBills } from "./purchasing";

export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    orderNumber: text("orderNumber").notNull(),
    orderType: text("orderType").notNull(),
    customerId: text("customerId").references(() => customers.id, { onDelete: "restrict" }),
    outletId: text("outletId").references(() => outlets.id, { onDelete: "restrict" }).notNull(),
    status: text("status").notNull(),
    totalPaise: integer("totalPaise").notNull(),
    version: integer("version").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [uniqueIndex("orders_order_number_unique").on(t.orderNumber)],
);

export const invoices = sqliteTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    invoiceNumber: text("invoiceNumber").notNull(),
    orderId: text("orderId").references(() => orders.id, { onDelete: "restrict" }),
    customerId: text("customerId").references(() => customers.id, { onDelete: "restrict" }),
    outletId: text("outletId").references(() => outlets.id, { onDelete: "restrict" }).notNull(),
    status: text("status").notNull(),
    subtotalPaise: integer("subtotalPaise").notNull(),
    taxPaise: integer("taxPaise").notNull(),
    totalPaise: integer("totalPaise").notNull(),
    pdfPath: text("pdfPath"),
    supersedesId: text("supersedesId").references((): AnySQLiteColumn => invoices.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [uniqueIndex("invoices_invoice_number_unique").on(t.invoiceNumber)],
);

export type InvoiceAllocation = { batchId: string; qty: number };

export const invoiceItems = sqliteTable(
  "invoice_items",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoiceId").references(() => invoices.id, { onDelete: "cascade" }).notNull(),
    variantId: text("variantId").references(() => variants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    quantity: integer("quantity").notNull(),
    unitPricePaise: integer("unitPricePaise").notNull(),
    taxRatePct: integer("taxRatePct").notNull(),
    taxAmountPaise: integer("taxAmountPaise").notNull(),
    lineTotalPaise: integer("lineTotalPaise").notNull(),
    isCustomItem: integer("isCustomItem").notNull(),
    allocations: text("allocations", { mode: "json" }).$type<InvoiceAllocation[]>().notNull(),
  },
  (t) => [index("invoice_items_invoice_idx").on(t.invoiceId)],
);

export const invoiceCharges = sqliteTable(
  "invoice_charges",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoiceId").references(() => invoices.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    amountPaise: integer("amountPaise").notNull(),
  },
  (t) => [index("invoice_charges_invoice_idx").on(t.invoiceId)],
);

export const returns = sqliteTable(
  "returns",
  {
    id: text("id").primaryKey(),
    returnNumber: text("returnNumber").notNull(),
    returnType: text("returnType").notNull(),
    orderId: text("orderId").references(() => orders.id, { onDelete: "restrict" }),
    purchaseBillId: text("purchaseBillId").references(() => purchaseBills.id, { onDelete: "restrict" }),
    outletId: text("outletId").references(() => outlets.id, { onDelete: "restrict" }).notNull(),
    status: text("status").notNull(),
    version: integer("version").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [uniqueIndex("returns_return_number_unique").on(t.returnNumber)],
);

export const returnItems = sqliteTable(
  "return_items",
  {
    id: text("id").primaryKey(),
    returnId: text("returnId").references(() => returns.id, { onDelete: "cascade" }).notNull(),
    variantId: text("variantId").references(() => variants.id, { onDelete: "restrict" }).notNull(),
    originalItemId: text("originalItemId").notNull(),
    quantity: integer("quantity").notNull(),
    unitPricePaise: integer("unitPricePaise").notNull(),
    taxAmountPaise: integer("taxAmountPaise").notNull(),
  },
  (t) => [index("return_items_return_idx").on(t.returnId)],
);

export const shipments = sqliteTable(
  "shipments",
  {
    id: text("id").primaryKey(),
    shipmentNumber: text("shipmentNumber").notNull(),
    invoiceId: text("invoiceId").references(() => invoices.id, { onDelete: "restrict" }).notNull(),
    carrier: text("carrier").notNull(),
    awbNumber: text("awbNumber"),
    status: text("status").notNull(),
    version: integer("version").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [
    uniqueIndex("shipments_shipment_number_unique").on(t.shipmentNumber),
    index("shipments_invoice_idx").on(t.invoiceId),
  ],
);
