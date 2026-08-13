import { randomUUIDv7 } from "bun";
import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { custAddresses, products, variants } from "../db/schema/catalog";
import { cartItems, wishlistItems } from "../db/schema/cart";
import { db } from "../lib/db";
import type { Tx } from "../lib/db";

type CartItemRow = typeof cartItems.$inferSelect;
type WishlistItemRow = typeof wishlistItems.$inferSelect;
type CustAddressRow = typeof custAddresses.$inferSelect;

/**
 * Cart & wishlist persistence (`architecture.md` §4.11): [STAGING] rows keyed
 * by `customerId`, cross-device by design. Writes produce zero fact-table rows
 * and zero events (I11) — convenience state only, never a pricing input;
 * checkout always re-derives. The customer is never taken from the payload —
 * every function takes it as the `customerId` argument the route resolved from
 * the session.
 */

export type CartDisplayRow = {
  id: string;
  variantId: string;
  quantity: number;
  name: string;
  sku: string | null;
  productSlug: string;
  unitPricePaise: number;
  lineTotalPaise: number;
  createdAt: number;
  updatedAt: number;
};

export function listCart(customerId: string): CartDisplayRow[] {
  const rows = db
    .select({
      id: cartItems.id,
      variantId: cartItems.variantId,
      quantity: cartItems.quantity,
      name: variants.name,
      sku: variants.sku,
      productSlug: products.slug,
      unitPricePaise: variants.sellingPricePaise,
      createdAt: cartItems.createdAt,
      updatedAt: cartItems.updatedAt,
    })
    .from(cartItems)
    .innerJoin(variants, eq(variants.id, cartItems.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .where(eq(cartItems.customerId, customerId))
    .orderBy(asc(cartItems.createdAt), asc(cartItems.id))
    .all();
  return rows.map((row) => ({ ...row, lineTotalPaise: row.unitPricePaise * row.quantity }));
}

/** Upsert (`api.md` §9): `UNIQUE(customerId, variantId)` — a repeat PUT of the
 * same variant replaces the quantity, never duplicates the line. The variant
 * must exist (404); pricing on the row is never trusted by anything. */
export function upsertCartItem(tx: Tx, customerId: string, variantId: string, quantity: number): CartItemRow {
  const variant = tx.select({ id: variants.id }).from(variants).where(eq(variants.id, variantId)).get();
  if (!variant) throw new HTTPException(404, { message: "not_found" });
  const now = Date.now();
  const existing = tx
    .select()
    .from(cartItems)
    .where(and(eq(cartItems.customerId, customerId), eq(cartItems.variantId, variantId)))
    .get();
  if (existing) {
    tx.update(cartItems)
      .set({ quantity, updatedAt: now })
      .where(eq(cartItems.id, existing.id))
      .run();
    return { ...existing, quantity, updatedAt: now };
  }
  const row: CartItemRow = {
    id: randomUUIDv7(),
    customerId,
    variantId,
    quantity,
    createdAt: now,
    updatedAt: now,
  };
  tx.insert(cartItems).values(row).run();
  return row;
}

/** Returns the removed row, or `null` when the line was not in the cart. */
export function deleteCartItem(tx: Tx, customerId: string, variantId: string): CartItemRow | null {
  const existing = tx
    .select()
    .from(cartItems)
    .where(and(eq(cartItems.customerId, customerId), eq(cartItems.variantId, variantId)))
    .get();
  if (!existing) return null;
  tx.delete(cartItems).where(eq(cartItems.id, existing.id)).run();
  return existing;
}

export type WishlistDisplayRow = {
  id: string;
  variantId: string;
  name: string;
  sku: string | null;
  productSlug: string;
  sellingPricePaise: number;
  createdAt: number;
};

export function listWishlist(customerId: string): WishlistDisplayRow[] {
  return db
    .select({
      id: wishlistItems.id,
      variantId: wishlistItems.variantId,
      name: variants.name,
      sku: variants.sku,
      productSlug: products.slug,
      sellingPricePaise: variants.sellingPricePaise,
      createdAt: wishlistItems.createdAt,
    })
    .from(wishlistItems)
    .innerJoin(variants, eq(variants.id, wishlistItems.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .where(eq(wishlistItems.customerId, customerId))
    .orderBy(asc(wishlistItems.createdAt), asc(wishlistItems.id))
    .all();
}

/** Add is an upsert: a duplicate `(customerId, variantId)` is a no-op. */
export function addWishlistItem(tx: Tx, customerId: string, variantId: string): WishlistItemRow {
  const variant = tx.select({ id: variants.id }).from(variants).where(eq(variants.id, variantId)).get();
  if (!variant) throw new HTTPException(404, { message: "not_found" });
  const existing = tx
    .select()
    .from(wishlistItems)
    .where(and(eq(wishlistItems.customerId, customerId), eq(wishlistItems.variantId, variantId)))
    .get();
  if (existing) return existing;
  const row: WishlistItemRow = {
    id: randomUUIDv7(),
    customerId,
    variantId,
    createdAt: Date.now(),
  };
  tx.insert(wishlistItems).values(row).run();
  return row;
}

/** Returns the removed row, or `null` when the item was not wished for. */
export function deleteWishlistItem(tx: Tx, customerId: string, variantId: string): WishlistItemRow | null {
  const existing = tx
    .select()
    .from(wishlistItems)
    .where(and(eq(wishlistItems.customerId, customerId), eq(wishlistItems.variantId, variantId)))
    .get();
  if (!existing) return null;
  tx.delete(wishlistItems).where(eq(wishlistItems.id, existing.id)).run();
  return existing;
}

export type CreateAddressInput = {
  label: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  pincode: string;
};

export function listAddresses(customerId: string): CustAddressRow[] {
  return db
    .select()
    .from(custAddresses)
    .where(eq(custAddresses.customerId, customerId))
    .orderBy(asc(custAddresses.id))
    .all();
}

/** Own rows only — any other id is indistinguishable from a missing row. */
export function getAddress(customerId: string, addressId: string): CustAddressRow | null {
  return (
    db
      .select()
      .from(custAddresses)
      .where(and(eq(custAddresses.id, addressId), eq(custAddresses.customerId, customerId)))
      .get() ?? null
  );
}

export function createAddress(tx: Tx, customerId: string, input: CreateAddressInput): CustAddressRow {
  const row: CustAddressRow = {
    id: randomUUIDv7(),
    customerId,
    label: input.label,
    line1: input.line1,
    line2: input.line2 ?? null,
    city: input.city,
    state: input.state,
    pincode: input.pincode,
  };
  tx.insert(custAddresses).values(row).run();
  return row;
}
