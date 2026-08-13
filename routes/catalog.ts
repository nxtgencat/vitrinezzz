import { randomUUIDv7 } from "bun";
import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, count, desc, eq, like, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { categories, products, variants } from "../db/schema/catalog";
import { media } from "../db/schema/media";
import { stockLevels } from "../db/schema/inventory";
import { db } from "../lib/db";
import { respondIdempotent, withIdempotency } from "../lib/idempotency";
import { logger } from "../lib/logger";
import { storage } from "../lib/storage";
import { jsonValidator, paramValidator, queryValidator } from "../lib/validate";
import { requireCapability, requireStaff } from "../services/rbac";
import type { StaffActor } from "../services/rbac";
import {
  createCategory,
  createProduct,
  createVariant,
  deactivateProduct,
  updateCategory,
  updateProduct,
  updateVariant,
} from "../services/catalog";
import {
  MEDIA_MAX_BYTES,
  deleteMedia,
  isMediaMimeType,
  makeThumbnail,
  mimeExt,
  uploadMedia,
} from "../services/media";
import type { MediaMimeType } from "../services/media";

export const catalogRoutes = new Hono();

const paise = z.number().int().min(0);
const flag = z.union([z.literal(0), z.literal(1)]);
const idParam = z.object({ id: z.uuid() });
const slugParam = z.object({ slug: z.string().min(1) });
const pageShape = {
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
};
const activeQuery = z.enum(["0", "1"]).optional();

function pagination(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

const categoryCreateSchema = z.object({
  name: z.string().min(1).max(200),
  parentId: z.uuid().nullable().optional(),
});

const categoryUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  parentId: z.uuid().nullable().optional(),
  isActive: flag.optional(),
});

const variantCreateSchema = z.object({
  productId: z.uuid(),
  name: z.string().min(1).max(200),
  sku: z.string().trim().min(1).nullable().optional(),
  barcode: z.string().trim().min(1).nullable().optional(),
  costPricePaise: paise,
  sellingPricePaise: paise,
  mrpPaise: paise.nullable().optional(),
  isTaxable: flag.optional(),
  isCustomerVisible: flag.optional(),
});

const variantUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  sku: z.string().trim().min(1).nullable().optional(),
  barcode: z.string().trim().min(1).nullable().optional(),
  costPricePaise: paise.optional(),
  sellingPricePaise: paise.optional(),
  mrpPaise: paise.optional(),
  isTaxable: flag.optional(),
  isCustomerVisible: flag.optional(),
  isActive: flag.optional(),
});

const productCreateSchema = z.object({
  categoryId: z.uuid().nullable().optional(),
  name: z.string().min(1).max(200),
  hsnCode: z.string().trim().max(50).nullable().optional(),
  gstRatePct: z.number().int().min(0).max(100).optional(),
  baseVariant: variantCreateSchema.omit({ productId: true }),
});

const productUpdateSchema = z.object({
  categoryId: z.uuid().nullable().optional(),
  name: z.string().min(1).max(200).optional(),
  hsnCode: z.string().trim().max(50).nullable().optional(),
  gstRatePct: z.number().int().min(0).max(100).optional(),
});

catalogRoutes.get(
  "/categories",
  queryValidator(z.object({ ...pageShape, active: activeQuery })),
  (c) => {
    const q = c.req.valid("query");
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const conditions = [];
    if (q.active !== undefined) conditions.push(eq(categories.isActive, Number(q.active)));
    const where = and(...conditions);
    const total = db.select({ n: count() }).from(categories).where(where).get()?.n ?? 0;
    const rows = db
      .select()
      .from(categories)
      .where(where)
      .orderBy(desc(categories.createdAt), desc(categories.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();
    return c.json({ data: rows, pagination: pagination(page, pageSize, total) });
  },
);

catalogRoutes.post("/categories", jsonValidator(categoryCreateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageCatalog");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => createCategory(tx, actor, body),
  });
  return respondIdempotent(c, result);
});

catalogRoutes.put(
  "/categories/:id",
  paramValidator(idParam),
  jsonValidator(categoryUpdateSchema),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManageCatalog");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const key = c.req.header("Idempotency-Key");
    const result = await withIdempotency({
      operation: `${c.req.method} ${c.req.routePath}`,
      key,
      actorId: actor.userId,
      body,
      run: (tx) => updateCategory(tx, actor, id, body),
    });
    return respondIdempotent(c, result);
  },
);

catalogRoutes.get(
  "/products",
  queryValidator(
    z.object({
      ...pageShape,
      q: z.string().trim().max(200).optional(),
      categoryId: z.uuid().optional(),
      active: activeQuery,
    }),
  ),
  (c) => {
    const q = c.req.valid("query");
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const conditions = [];
    if (q.q) conditions.push(like(products.name, `%${q.q}%`));
    if (q.categoryId) conditions.push(eq(products.categoryId, q.categoryId));
    if (q.active !== undefined) conditions.push(eq(products.isActive, Number(q.active)));
    const where = and(...conditions);
    const total = db.select({ n: count() }).from(products).where(where).get()?.n ?? 0;
    const rows = db
      .select()
      .from(products)
      .where(where)
      .orderBy(desc(products.createdAt), desc(products.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();
    return c.json({ data: rows, pagination: pagination(page, pageSize, total) });
  },
);

catalogRoutes.get("/products/:slug", paramValidator(slugParam), (c) => {
  const { slug } = c.req.valid("param");
  const product = db.select().from(products).where(eq(products.slug, slug)).get();
  if (!product) throw new HTTPException(404, { message: "not_found" });
  const variantRows = db
    .select()
    .from(variants)
    .where(eq(variants.productId, product.id))
    .orderBy(asc(variants.isBase), asc(variants.name))
    .all();
  const productMedia = db
    .select()
    .from(media)
    .where(and(eq(media.ownerType, "product"), eq(media.ownerId, product.id)))
    .orderBy(asc(media.createdAt))
    .all();
  const variantsWithMedia = variantRows.map((variant) => ({
    ...variant,
    media: db
      .select()
      .from(media)
      .where(and(eq(media.ownerType, "variant"), eq(media.ownerId, variant.id)))
      .orderBy(asc(media.createdAt))
      .all(),
  }));
  return c.json({ ...product, media: productMedia, variants: variantsWithMedia });
});

catalogRoutes.post("/products", jsonValidator(productCreateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageCatalog");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => createProduct(tx, actor, body),
  });
  return respondIdempotent(c, result);
});

catalogRoutes.put(
  "/products/:id",
  paramValidator(idParam),
  jsonValidator(productUpdateSchema),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManageCatalog");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const key = c.req.header("Idempotency-Key");
    const result = await withIdempotency({
      operation: `${c.req.method} ${c.req.routePath}`,
      key,
      actorId: actor.userId,
      body,
      run: (tx) => updateProduct(tx, actor, id, body),
    });
    return respondIdempotent(c, result);
  },
);

catalogRoutes.post(
  "/products/:id/deactivate",
  paramValidator(idParam),
  jsonValidator(z.object({})),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManageCatalog");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const key = c.req.header("Idempotency-Key");
    const result = await withIdempotency({
      operation: `${c.req.method} ${c.req.routePath}`,
      key,
      actorId: actor.userId,
      body,
      run: (tx) => deactivateProduct(tx, actor, id),
    });
    return respondIdempotent(c, result);
  },
);

catalogRoutes.get(
  "/variants",
  queryValidator(
    z.object({
      ...pageShape,
      productId: z.uuid().optional(),
      q: z.string().trim().max(200).optional(),
      outletId: z.uuid().optional(),
      active: activeQuery,
    }),
  ),
  (c) => {
    const q = c.req.valid("query");
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const conditions = [];
    if (q.productId) conditions.push(eq(variants.productId, q.productId));
    if (q.q) conditions.push(or(like(variants.name, `%${q.q}%`), like(variants.sku, `%${q.q}%`)));
    if (q.active !== undefined) conditions.push(eq(variants.isActive, Number(q.active)));
    const where = and(...conditions);
    const total = db.select({ n: count() }).from(variants).where(where).get()?.n ?? 0;
    const rows = db
      .select()
      .from(variants)
      .where(where)
      .orderBy(desc(variants.createdAt), desc(variants.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();
    let stockQtyByVariant: Map<string, number> = new Map();
    if (q.outletId) {
      const sums = db
        .select({
          variantId: stockLevels.variantId,
          total: sql<number>`coalesce(sum(${stockLevels.quantity}), 0)`,
        })
        .from(stockLevels)
        .where(eq(stockLevels.outletId, q.outletId))
        .groupBy(stockLevels.variantId)
        .all();
      stockQtyByVariant = new Map(sums.map((s) => [s.variantId, s.total]));
    }
    const data = rows.map((row) => ({
      ...row,
      stockQty: q.outletId ? (stockQtyByVariant.get(row.id) ?? 0) : undefined,
    }));
    return c.json({ data, pagination: pagination(page, pageSize, total) });
  },
);

catalogRoutes.post("/variants", jsonValidator(variantCreateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageCatalog");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => createVariant(tx, actor, body),
  });
  return respondIdempotent(c, result);
});

catalogRoutes.put(
  "/variants/:id",
  paramValidator(idParam),
  jsonValidator(variantUpdateSchema),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManageCatalog");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const key = c.req.header("Idempotency-Key");
    const result = await withIdempotency({
      operation: `${c.req.method} ${c.req.routePath}`,
      key,
      actorId: actor.userId,
      body,
      run: (tx) => updateVariant(tx, actor, id, body),
    });
    return respondIdempotent(c, result);
  },
);

/**
 * Best-effort storage cleanup for files written for an upload attempt that
 * was rolled back, replayed, or rejected — never throws (degrade safely).
 */
async function cleanupFiles(keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      await storage.delete(key);
    } catch (err) {
      logger.warn({ err, key }, "media cleanup failed");
    }
  }
}

/**
 * Shared multipart upload path for product/variant media (`api.md` §3):
 * validates MIME + size, generates the WebP thumbnail, writes both files to
 * storage, then inserts `media` + `audit_events` in one transaction. File I/O
 * is async and cannot live inside a transaction (T1) — the route writes the
 * files first, and deletes them again on replay/rollback, so the DB is always
 * consistent even though a failed attempt may briefly leave orphaned bytes.
 * The idempotency hash binds the request to the file's sha256, so reusing a
 * key with different bytes is a `409 idempotency_mismatch`.
 */
async function handleUpload(
  c: Context,
  actor: StaffActor,
  ownerType: "product" | "variant",
  ownerId: string,
): Promise<Response> {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new HTTPException(400, { message: "media file required" });
  }
  if (!isMediaMimeType(file.type)) {
    throw new HTTPException(400, { message: "unsupported media type" });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MEDIA_MAX_BYTES) {
    throw new HTTPException(400, { message: "file too large" });
  }
  const altRaw = form.get("altText");
  const altText = typeof altRaw === "string" ? altRaw.trim() : null;
  if (altText !== null && altText.length > 500) {
    throw new HTTPException(400, { message: "altText too long" });
  }
  const mimeType = file.type as MediaMimeType;
  const thumb = await makeThumbnail(bytes);
  const mediaId = randomUUIDv7();
  const path = `media/${mediaId}.${mimeExt(mimeType)}`;
  const thumbPath = `media/${mediaId}.webp`;
  await storage.put(path, bytes, mimeType);
  await storage.put(thumbPath, thumb, "image/webp");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const body = {
    ownerType,
    ownerId,
    altText,
    fileName: file.name,
    mimeType,
    sizeBytes: bytes.length,
    sha256: hasher.digest("hex"),
  };
  const key = c.req.header("Idempotency-Key");
  let result;
  try {
    result = await withIdempotency({
      operation: `${c.req.method} ${c.req.routePath}`,
      key,
      actorId: actor.userId,
      body,
      run: (tx) =>
        uploadMedia(tx, actor, {
          ownerType,
          ownerId,
          path,
          thumbPath,
          mimeType,
          sizeBytes: bytes.length,
          altText,
        }),
    });
  } catch (err) {
    await cleanupFiles([path, thumbPath]);
    throw err;
  }
  if (result.replayed) {
    await cleanupFiles([path, thumbPath]);
  }
  return respondIdempotent(c, result);
}

catalogRoutes.get("/products/:id/media", paramValidator(idParam), (c) => {
  const { id } = c.req.valid("param");
  const owner = db.select({ id: products.id }).from(products).where(eq(products.id, id)).get();
  if (!owner) throw new HTTPException(404, { message: "not_found" });
  const rows = db
    .select()
    .from(media)
    .where(and(eq(media.ownerType, "product"), eq(media.ownerId, id)))
    .orderBy(asc(media.createdAt), asc(media.id))
    .all();
  return c.json({ data: rows });
});

catalogRoutes.post("/products/:id/media", paramValidator(idParam), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageCatalog");
  const { id } = c.req.valid("param");
  const owner = db.select({ id: products.id }).from(products).where(eq(products.id, id)).get();
  if (!owner) throw new HTTPException(404, { message: "not_found" });
  return handleUpload(c, actor, "product", id);
});

catalogRoutes.get("/variants/:id/media", paramValidator(idParam), (c) => {
  const { id } = c.req.valid("param");
  const owner = db.select({ id: variants.id }).from(variants).where(eq(variants.id, id)).get();
  if (!owner) throw new HTTPException(404, { message: "not_found" });
  const rows = db
    .select()
    .from(media)
    .where(and(eq(media.ownerType, "variant"), eq(media.ownerId, id)))
    .orderBy(asc(media.createdAt), asc(media.id))
    .all();
  return c.json({ data: rows });
});

catalogRoutes.post("/variants/:id/media", paramValidator(idParam), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageCatalog");
  const { id } = c.req.valid("param");
  const owner = db.select({ id: variants.id }).from(variants).where(eq(variants.id, id)).get();
  if (!owner) throw new HTTPException(404, { message: "not_found" });
  return handleUpload(c, actor, "variant", id);
});

catalogRoutes.get("/media/:id", paramValidator(idParam), async (c) => {
  const { id } = c.req.valid("param");
  const row = db.select().from(media).where(eq(media.id, id)).get();
  if (!row) throw new HTTPException(404, { message: "not_found" });
  const bytes = await storage.get(row.path);
  if (!bytes) throw new HTTPException(404, { message: "not_found" });
  return new Response(bytes, { status: 200, headers: { "content-type": row.mimeType } });
});

catalogRoutes.delete("/media/:id", paramValidator(idParam), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageCatalog");
  const { id } = c.req.valid("param");
  const row = db.select().from(media).where(eq(media.id, id)).get();
  if (!row) throw new HTTPException(404, { message: "not_found" });
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body: {},
    run: (tx) => deleteMedia(tx, actor, id),
  });
  if (!result.replayed) {
    await cleanupFiles([row.path, row.thumbPath].filter((k): k is string => Boolean(k)));
  }
  return respondIdempotent(c, result);
});