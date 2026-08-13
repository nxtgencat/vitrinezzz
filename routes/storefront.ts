import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import { z } from "zod";
import { products, variants } from "../db/schema/catalog";
import { stockLevels } from "../db/schema/inventory";
import { db } from "../lib/db";
import { respondIdempotent, withIdempotency } from "../lib/idempotency";
import { checkRateLimit } from "../lib/rate-limit";
import { publish } from "../lib/realtime";
import { jsonValidator, paramValidator, queryValidator } from "../lib/validate";
import { requireCustomer } from "../services/rbac";
import {
  addWishlistItem,
  createAddress,
  deleteCartItem,
  deleteWishlistItem,
  getAddress,
  listAddresses,
  listCart,
  listWishlist,
  upsertCartItem,
} from "../services/cart";
import {
  cancelCustomerOrder,
  getCustomerOrder,
  listCustomerOrders,
  resolveStorefrontOutlet,
  storefrontCheckout,
} from "../services/checkout";
import { createSalesReturn } from "../services/returns";

export const storefrontRoutes = new Hono();

const idParam = z.object({ id: z.uuid() });
const variantIdParam = z.object({ variantId: z.uuid() });
const slugParam = z.object({ slug: z.string().min(1) });

const cartPutSchema = z.object({
  variantId: z.uuid(),
  quantity: z.number().int().min(1),
}).strict();

const wishlistPostSchema = z.object({ variantId: z.uuid() }).strict();

const addressCreateSchema = z.object({
  label: z.string().trim().min(1).max(100),
  line1: z.string().trim().min(1).max(300),
  line2: z.string().trim().min(1).max(300).nullable().optional(),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100),
  pincode: z.string().trim().min(1).max(20),
}).strict();

const checkoutSchema = z
  .object({
    custAddressId: z.uuid(),
    paymentMode: z.enum(["cod", "gateway"]),
  })
  .strict();

const returnCreateSchema = z
  .object({
    orderId: z.uuid(),
    items: z
      .array(z.object({ originalItemId: z.uuid(), quantity: z.number().int().min(1) }).strict())
      .min(1),
  })
  .strict();

/**
 * Public storefront catalog (`api.md` §9): `isActive` products that have at
 * least one `isCustomerVisible` variant, each variant carrying `isInStock` for
 * the resolved storefront outlet — never quantity. Stock is read from the
 * display projection (`stockLevels`), which is safe here because this endpoint
 * is display-only by construction (no decision is ever made off it).
 */
storefrontRoutes.get("/storefront/products", queryValidator(z.object({ q: z.string().trim().max(200).optional() })), (c) => {
  const q = c.req.valid("query");
  const outletId = resolveStorefrontOutlet(db as never).id;
  const variantConditions = [eq(variants.isActive, 1), eq(variants.isCustomerVisible, 1)];
  if (q.q) {
    const productMatch = db.select({ id: products.id }).from(products).where(like(products.name, `%${q.q}%`)).all();
    variantConditions.push(inArray(variants.productId, productMatch.map((p) => p.id)));
  }
  const variantRows = db
    .select()
    .from(variants)
    .where(and(...variantConditions))
    .orderBy(asc(variants.isBase), asc(variants.name), asc(variants.id))
    .all();
  const variantIds = variantRows.map((v) => v.id);
  const productIds = [...new Set(variantRows.map((v) => v.productId))];
  const inStockIds = new Set<string>();
  if (outletId && variantIds.length > 0) {
    const sums = db
      .select({
        variantId: stockLevels.variantId,
        total: sql<number>`coalesce(sum(${stockLevels.quantity}), 0)`,
      })
      .from(stockLevels)
      .where(and(eq(stockLevels.outletId, outletId), inArray(stockLevels.variantId, variantIds)))
      .groupBy(stockLevels.variantId)
      .all();
    for (const s of sums) {
      if (s.total > 0) inStockIds.add(s.variantId);
    }
  }
  const productRows =
    productIds.length > 0
      ? db.select().from(products).where(and(eq(products.isActive, 1), inArray(products.id, productIds))).orderBy(asc(products.name), asc(products.id)).all()
      : [];
  const variantsByProduct = new Map<string, (typeof variants.$inferSelect)[]>();
  for (const v of variantRows) {
    const list = variantsByProduct.get(v.productId) ?? [];
    list.push(v);
    variantsByProduct.set(v.productId, list);
  }
  const data = productRows.map((product) => ({
    ...product,
    variants: (variantsByProduct.get(product.id) ?? []).map((v) => ({ ...v, isInStock: inStockIds.has(v.id) })),
  }));
  return c.json({ data });
});

storefrontRoutes.get("/storefront/products/:slug", paramValidator(slugParam), (c) => {
  const { slug } = c.req.valid("param");
  const product = db.select().from(products).where(and(eq(products.slug, slug), eq(products.isActive, 1))).get();
  if (!product) throw new HTTPException(404, { message: "not_found" });
  const variantRows = db
    .select()
    .from(variants)
    .where(and(eq(variants.productId, product.id), eq(variants.isActive, 1), eq(variants.isCustomerVisible, 1)))
    .orderBy(asc(variants.isBase), asc(variants.name))
    .all();
  if (variantRows.length === 0) throw new HTTPException(404, { message: "not_found" });
  return c.json({ ...product, variants: variantRows });
});

storefrontRoutes.get("/storefront/cart", async (c) => {
  const customer = await requireCustomer(c.req.raw.headers);
  return c.json({ data: listCart(customer.customerId) });
});

storefrontRoutes.put("/storefront/cart", jsonValidator(cartPutSchema), async (c) => {
  const customer = await requireCustomer(c.req.raw.headers);
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: customer.userId,
    body,
    run: (tx) => upsertCartItem(tx, customer.customerId, body.variantId, body.quantity),
  });
  return respondIdempotent(c, result);
});

storefrontRoutes.delete("/storefront/cart/:variantId", paramValidator(variantIdParam), jsonValidator(z.object({})), async (c) => {
  const customer = await requireCustomer(c.req.raw.headers);
  const { variantId } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: customer.userId,
    body,
    run: (tx) => deleteCartItem(tx, customer.customerId, variantId) ?? {},
  });
  return respondIdempotent(c, result);
});

storefrontRoutes.get("/storefront/wishlist", async (c) => {
  const customer = await requireCustomer(c.req.raw.headers);
  return c.json({ data: listWishlist(customer.customerId) });
});

storefrontRoutes.post("/storefront/wishlist", jsonValidator(wishlistPostSchema), async (c) => {
  const customer = await requireCustomer(c.req.raw.headers);
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: customer.userId,
    body,
    run: (tx) => addWishlistItem(tx, customer.customerId, body.variantId),
  });
  return respondIdempotent(c, result);
});

storefrontRoutes.delete("/storefront/wishlist/:variantId", paramValidator(variantIdParam), jsonValidator(z.object({})), async (c) => {
  const customer = await requireCustomer(c.req.raw.headers);
  const { variantId } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: customer.userId,
    body,
    run: (tx) => deleteWishlistItem(tx, customer.customerId, variantId) ?? {},
  });
  return respondIdempotent(c, result);
});

storefrontRoutes.get("/storefront/addresses", async (c) => {
  const customer = await requireCustomer(c.req.raw.headers);
  return c.json({ data: listAddresses(customer.customerId) });
});

storefrontRoutes.post("/storefront/addresses", jsonValidator(addressCreateSchema), async (c) => {
  const customer = await requireCustomer(c.req.raw.headers);
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: customer.userId,
    body,
    run: (tx) => createAddress(tx, customer.customerId, body),
  });
  return respondIdempotent(c, result);
});

storefrontRoutes.get("/storefront/addresses/:id", paramValidator(idParam), async (c) => {
  const customer = await requireCustomer(c.req.raw.headers);
  const { id } = c.req.valid("param");
  const address = getAddress(customer.customerId, id);
  if (!address) throw new HTTPException(404, { message: "not_found" });
  return c.json(address);
});

storefrontRoutes.post("/storefront/checkout", jsonValidator(checkoutSchema), async (c) => {
  const customer = await requireCustomer(c.req.raw.headers);
  checkRateLimit(`checkout:${customer.userId}`, 5, 60_000);
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: customer.userId,
    body,
    run: (tx) => storefrontCheckout(tx, customer, body),
  });
  if (!result.replayed && result.value) {
    const checkout = result.value as ReturnType<typeof storefrontCheckout>;
    if (checkout.order.status === "confirmed") {
      publish("order:" + checkout.order.id, "order.confirmed", checkout.order.id);
      publish("invoice:" + checkout.invoice.id, "invoice.issued", checkout.invoice.id);
      publish("stock:" + checkout.invoice.outletId, "stock.changed", checkout.invoice.outletId);
    } else {
      publish("order:" + checkout.order.id, "order.created", checkout.order.id);
    }
  }
  return respondIdempotent(c, result);
});

storefrontRoutes.get("/storefront/orders", async (c) => {
  const customer = await requireCustomer(c.req.raw.headers);
  return c.json({ data: listCustomerOrders(customer.customerId) });
});

storefrontRoutes.get("/storefront/orders/:id", paramValidator(idParam), async (c) => {
  const customer = await requireCustomer(c.req.raw.headers);
  const { id } = c.req.valid("param");
  const order = getCustomerOrder(customer.customerId, id);
  if (!order) throw new HTTPException(404, { message: "not_found" });
  return c.json(order);
});

storefrontRoutes.post("/storefront/orders/:id/cancel", paramValidator(idParam), jsonValidator(z.object({})), async (c) => {
  const customer = await requireCustomer(c.req.raw.headers);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: customer.userId,
    body,
    run: (tx) => cancelCustomerOrder(tx, customer, id),
  });
  if (!result.replayed && result.value) {
    const cancelled = result.value as ReturnType<typeof cancelCustomerOrder>;
    publish("order:" + cancelled.id, "order.cancelled", cancelled.id);
  }
  return respondIdempotent(c, result);
});

storefrontRoutes.post("/storefront/returns", jsonValidator(returnCreateSchema), async (c) => {
  const customer = await requireCustomer(c.req.raw.headers);
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: customer.userId,
    body,
    run: (tx) => createSalesReturn(tx, customer, body),
  });
  return respondIdempotent(c, result);
});