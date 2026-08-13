import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { customers, variants } from "./catalog";

export const cartItems = sqliteTable(
  "cart_items",
  {
    id: text("id").primaryKey(),
    customerId: text("customerId").references(() => customers.id, { onDelete: "restrict" }).notNull(),
    variantId: text("variantId").references(() => variants.id, { onDelete: "restrict" }).notNull(),
    quantity: integer("quantity").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [uniqueIndex("cart_items_customer_variant_unique").on(t.customerId, t.variantId)],
);

export const wishlistItems = sqliteTable(
  "wishlist_items",
  {
    id: text("id").primaryKey(),
    customerId: text("customerId").references(() => customers.id, { onDelete: "restrict" }).notNull(),
    variantId: text("variantId").references(() => variants.id, { onDelete: "restrict" }).notNull(),
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [uniqueIndex("wishlist_items_customer_variant_unique").on(t.customerId, t.variantId)],
);
