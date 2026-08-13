import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth";

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    parentId: text("parentId").references((): AnySQLiteColumn => categories.id, { onDelete: "restrict" }),
    isActive: integer("isActive").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [index("categories_parent_id_idx").on(t.parentId)],
);

export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    categoryId: text("categoryId").references(() => categories.id, { onDelete: "restrict" }).notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    hsnCode: text("hsnCode").notNull(),
    gstRatePct: integer("gstRatePct").notNull(),
    isActive: integer("isActive").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [
    uniqueIndex("products_slug_unique").on(t.slug),
    index("products_category_id_idx").on(t.categoryId),
  ],
);

export const variants = sqliteTable(
  "variants",
  {
    id: text("id").primaryKey(),
    productId: text("productId").references(() => products.id, { onDelete: "restrict" }).notNull(),
    name: text("name").notNull(),
    sku: text("sku"),
    barcode: text("barcode"),
    costPricePaise: integer("costPricePaise").notNull(),
    sellingPricePaise: integer("sellingPricePaise").notNull(),
    mrpPaise: integer("mrpPaise").notNull(),
    isBase: integer("isBase").notNull(),
    isTaxable: integer("isTaxable").notNull(),
    isCustomerVisible: integer("isCustomerVisible").notNull(),
    isActive: integer("isActive").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [
    uniqueIndex("variants_sku_unique").on(t.sku).where(sql`${t.sku} IS NOT NULL`),
    uniqueIndex("variants_barcode_unique").on(t.barcode).where(sql`${t.barcode} IS NOT NULL`),
    uniqueIndex("variants_product_id_is_base_unique").on(t.productId).where(sql`${t.isBase} = 1`),
    index("variants_product_id_idx").on(t.productId),
  ],
);

export const batches = sqliteTable(
  "batches",
  {
    id: text("id").primaryKey(),
    variantId: text("variantId").references(() => variants.id, { onDelete: "restrict" }).notNull(),
    batchNumber: text("batchNumber").notNull(),
    expiryDate: integer("expiryDate"),
    costPricePaise: integer("costPricePaise").notNull(),
    isActive: integer("isActive").notNull(),
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [uniqueIndex("batches_variant_id_batch_number_unique").on(t.variantId, t.batchNumber)],
);

export const customers = sqliteTable(
  "customers",
  {
    id: text("id").primaryKey(),
    userId: text("userId").references(() => user.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    phone: text("phone"),
    gstin: text("gstin"),
    isActive: integer("isActive").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [
    uniqueIndex("customers_user_id_unique").on(t.userId).where(sql`${t.userId} IS NOT NULL`),
    uniqueIndex("customers_phone_unique").on(t.phone).where(sql`${t.phone} IS NOT NULL`),
  ],
);

export const custAddresses = sqliteTable(
  "cust_addresses",
  {
    id: text("id").primaryKey(),
    customerId: text("customerId").references(() => customers.id, { onDelete: "cascade" }).notNull(),
    label: text("label").notNull(),
    line1: text("line1").notNull(),
    line2: text("line2"),
    city: text("city").notNull(),
    state: text("state").notNull(),
    pincode: text("pincode").notNull(),
  },
  (t) => [index("cust_addresses_customer_id_idx").on(t.customerId)],
);

export const vendors = sqliteTable("vendors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  gstin: text("gstin"),
  isActive: integer("isActive").notNull(),
  createdAt: integer("createdAt").notNull(),
  updatedAt: integer("updatedAt").notNull(),
});
