import { randomUUIDv7 } from "bun";
import { and, eq, not } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { categories, products, variants } from "../db/schema/catalog";
import type { Tx } from "../lib/db";
import { writeAuditEvent } from "./audit";
import { requireCapability } from "./rbac";
import type { StaffActor } from "./rbac";

type CategoryRow = typeof categories.$inferSelect;
type ProductRow = typeof products.$inferSelect;
type VariantRow = typeof variants.$inferSelect;

/**
 * Server-side slug derivation (`api.md` §3): lowercase, non-alphanumeric runs
 * become `-`, leading/trailing hyphens trimmed. A name with no ASCII
 * alphanumerics falls back to `product`. A collision with an existing slug is
 * a `409 duplicate_slug` — the slug is immutable thereafter.
 */
export function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "product";
}

function assertNoCategoryCycle(tx: Tx, categoryId: string, proposedParentId: string): void {
  let cursor: string | null = proposedParentId;
  for (let depth = 0; cursor && depth < 100; depth++) {
    if (cursor === categoryId) {
      throw new HTTPException(409, { message: "category_cycle" });
    }
    const row = tx
      .select({ parentId: categories.parentId })
      .from(categories)
      .where(eq(categories.id, cursor))
      .get();
    cursor = row?.parentId ?? null;
  }
}

function assertParentExists(tx: Tx, parentId: string): void {
  const parent = tx.select({ id: categories.id }).from(categories).where(eq(categories.id, parentId)).get();
  if (!parent) throw new HTTPException(404, { message: "not_found" });
}

export type CreateCategoryInput = {
  name: string;
  parentId?: string | null;
};

export function createCategory(tx: Tx, actor: StaffActor, input: CreateCategoryInput): CategoryRow {
  requireCapability(actor, "canManageCatalog");
  const parentId = input.parentId ?? null;
  if (parentId) assertParentExists(tx, parentId);
  const now = Date.now();
  const row: CategoryRow = {
    id: randomUUIDv7(),
    name: input.name,
    parentId,
    isActive: 1,
    createdAt: now,
    updatedAt: now,
  };
  tx.insert(categories).values(row).run();
  writeAuditEvent(tx, {
    entityType: "category",
    entityId: row.id,
    action: "created",
    actorId: actor.userId,
    actorType: "staff",
    before: null,
    after: { ...row },
  });
  return row;
}

export type UpdateCategoryInput = {
  name?: string;
  parentId?: string | null;
  isActive?: number;
};

export function updateCategory(
  tx: Tx,
  actor: StaffActor,
  categoryId: string,
  input: UpdateCategoryInput,
): CategoryRow {
  const existing = tx.select().from(categories).where(eq(categories.id, categoryId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManageCatalog");
  if (input.parentId && input.parentId !== existing.parentId) {
    assertParentExists(tx, input.parentId);
    assertNoCategoryCycle(tx, categoryId, input.parentId);
  }
  const now = Date.now();
  const next: CategoryRow = {
    ...existing,
    name: input.name ?? existing.name,
    parentId: input.parentId !== undefined ? (input.parentId ?? null) : existing.parentId,
    isActive: input.isActive ?? existing.isActive,
    updatedAt: now,
  };
  tx.update(categories)
    .set({ name: next.name, parentId: next.parentId, isActive: next.isActive, updatedAt: now })
    .where(eq(categories.id, categoryId))
    .run();
  writeAuditEvent(tx, {
    entityType: "category",
    entityId: categoryId,
    action: "updated",
    actorId: actor.userId,
    actorType: "staff",
    before: { ...existing },
    after: { ...next },
  });
  return next;
}

export type CreateVariantInput = {
  productId: string;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  costPricePaise: number;
  sellingPricePaise: number;
  mrpPaise?: number | null;
  isBase?: number;
  isTaxable?: number;
  isCustomerVisible?: number;
};

export function createVariant(tx: Tx, actor: StaffActor, input: CreateVariantInput): VariantRow {
  requireCapability(actor, "canManageCatalog");
  const product = tx.select({ id: products.id }).from(products).where(eq(products.id, input.productId)).get();
  if (!product) throw new HTTPException(404, { message: "not_found" });
  const sku = input.sku ?? null;
  const barcode = input.barcode ?? null;
  if (sku) {
    const dup = tx.select({ id: variants.id }).from(variants).where(eq(variants.sku, sku)).get();
    if (dup) throw new HTTPException(409, { message: "duplicate_sku" });
  }
  if (barcode) {
    const dup = tx.select({ id: variants.id }).from(variants).where(eq(variants.barcode, barcode)).get();
    if (dup) throw new HTTPException(409, { message: "duplicate_sku" });
  }
  const now = Date.now();
  const row: VariantRow = {
    id: randomUUIDv7(),
    productId: input.productId,
    name: input.name,
    sku,
    barcode,
    costPricePaise: input.costPricePaise,
    sellingPricePaise: input.sellingPricePaise,
    mrpPaise: input.mrpPaise ?? input.sellingPricePaise,
    isBase: input.isBase ?? 0,
    isTaxable: input.isTaxable ?? 1,
    isCustomerVisible: input.isCustomerVisible ?? 1,
    isActive: 1,
    createdAt: now,
    updatedAt: now,
  };
  try {
    tx.insert(variants).values(row).run();
  } catch (err) {
    if (String(err).includes("UNIQUE constraint failed")) {
      throw new HTTPException(409, { message: "duplicate_sku" });
    }
    throw err;
  }
  writeAuditEvent(tx, {
    entityType: "variant",
    entityId: row.id,
    action: "created",
    actorId: actor.userId,
    actorType: "staff",
    before: null,
    after: { ...row },
  });
  return row;
}

export type CreateProductInput = {
  categoryId?: string | null;
  name: string;
  hsnCode?: string | null;
  gstRatePct?: number;
  baseVariant: Omit<CreateVariantInput, "productId">;
};

export function createProduct(
  tx: Tx,
  actor: StaffActor,
  input: CreateProductInput,
): { product: ProductRow; baseVariant: VariantRow } {
  requireCapability(actor, "canManageCatalog");
  const categoryId = input.categoryId ?? null;
  if (categoryId) assertParentExists(tx, categoryId);
  const slug = slugifyName(input.name);
  const taken = tx.select({ id: products.id }).from(products).where(eq(products.slug, slug)).get();
  if (taken) throw new HTTPException(409, { message: "duplicate_slug" });
  const now = Date.now();
  const product: ProductRow = {
    id: randomUUIDv7(),
    categoryId,
    name: input.name,
    slug,
    hsnCode: input.hsnCode ?? "",
    gstRatePct: input.gstRatePct ?? 0,
    isActive: 1,
    createdAt: now,
    updatedAt: now,
  };
  try {
    tx.insert(products).values(product).run();
  } catch (err) {
    if (String(err).includes("UNIQUE constraint failed")) {
      throw new HTTPException(409, { message: "duplicate_slug" });
    }
    throw err;
  }
  const baseVariant = createVariant(tx, actor, {
    ...input.baseVariant,
    productId: product.id,
    isBase: 1,
    isTaxable: input.baseVariant.isTaxable ?? 1,
    isCustomerVisible: input.baseVariant.isCustomerVisible ?? 1,
  });
  writeAuditEvent(tx, {
    entityType: "product",
    entityId: product.id,
    action: "created",
    actorId: actor.userId,
    actorType: "staff",
    before: null,
    after: { ...product },
  });
  return { product, baseVariant };
}

export type UpdateProductInput = {
  categoryId?: string | null;
  name?: string;
  hsnCode?: string | null;
  gstRatePct?: number;
};

export function updateProduct(tx: Tx, actor: StaffActor, productId: string, input: UpdateProductInput): ProductRow {
  const existing = tx.select().from(products).where(eq(products.id, productId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManageCatalog");
  const categoryId = input.categoryId !== undefined ? (input.categoryId ?? null) : existing.categoryId;
  if (categoryId && categoryId !== existing.categoryId) assertParentExists(tx, categoryId);
  const now = Date.now();
  const next: ProductRow = {
    ...existing,
    categoryId,
    name: input.name ?? existing.name,
    hsnCode: input.hsnCode !== undefined ? (input.hsnCode ?? "") : existing.hsnCode,
    gstRatePct: input.gstRatePct ?? existing.gstRatePct,
    updatedAt: now,
  };
  tx.update(products)
    .set({ categoryId, name: next.name, hsnCode: next.hsnCode, gstRatePct: next.gstRatePct, updatedAt: now })
    .where(eq(products.id, productId))
    .run();
  writeAuditEvent(tx, {
    entityType: "product",
    entityId: productId,
    action: "updated",
    actorId: actor.userId,
    actorType: "staff",
    before: { ...existing },
    after: { ...next },
  });
  return next;
}

export function deactivateProduct(tx: Tx, actor: StaffActor, productId: string): ProductRow {
  const existing = tx.select().from(products).where(eq(products.id, productId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManageCatalog");
  if (existing.isActive === 0) return existing;
  const now = Date.now();
  const before = { ...existing };
  const after: ProductRow = { ...existing, isActive: 0, updatedAt: now };
  tx.update(products).set({ isActive: 0, updatedAt: now }).where(eq(products.id, productId)).run();
  writeAuditEvent(tx, {
    entityType: "product",
    entityId: productId,
    action: "deactivated",
    actorId: actor.userId,
    actorType: "staff",
    before,
    after: { ...after },
  });
  return after;
}

export type UpdateVariantInput = {
  name?: string;
  sku?: string | null;
  barcode?: string | null;
  costPricePaise?: number;
  sellingPricePaise?: number;
  mrpPaise?: number;
  isTaxable?: number;
  isCustomerVisible?: number;
  isActive?: number;
};

export function updateVariant(tx: Tx, actor: StaffActor, variantId: string, input: UpdateVariantInput): VariantRow {
  const existing = tx.select().from(variants).where(eq(variants.id, variantId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManageCatalog");
  const nextSku = input.sku !== undefined ? (input.sku ?? null) : existing.sku;
  const nextBarcode = input.barcode !== undefined ? (input.barcode ?? null) : existing.barcode;
  if (nextSku && nextSku !== existing.sku) {
    const dup = tx
      .select({ id: variants.id })
      .from(variants)
      .where(and(eq(variants.sku, nextSku), not(eq(variants.id, variantId))))
      .get();
    if (dup) throw new HTTPException(409, { message: "duplicate_sku" });
  }
  if (nextBarcode && nextBarcode !== existing.barcode) {
    const dup = tx
      .select({ id: variants.id })
      .from(variants)
      .where(and(eq(variants.barcode, nextBarcode), not(eq(variants.id, variantId))))
      .get();
    if (dup) throw new HTTPException(409, { message: "duplicate_sku" });
  }
  const now = Date.now();
  const next: VariantRow = {
    ...existing,
    name: input.name ?? existing.name,
    sku: nextSku,
    barcode: nextBarcode,
    costPricePaise: input.costPricePaise ?? existing.costPricePaise,
    sellingPricePaise: input.sellingPricePaise ?? existing.sellingPricePaise,
    mrpPaise: input.mrpPaise ?? existing.mrpPaise,
    isTaxable: input.isTaxable ?? existing.isTaxable,
    isCustomerVisible: input.isCustomerVisible ?? existing.isCustomerVisible,
    isActive: input.isActive ?? existing.isActive,
    updatedAt: now,
  };
  try {
    tx.update(variants)
      .set({
        name: next.name,
        sku: nextSku,
        barcode: nextBarcode,
        costPricePaise: next.costPricePaise,
        sellingPricePaise: next.sellingPricePaise,
        mrpPaise: next.mrpPaise,
        isTaxable: next.isTaxable,
        isCustomerVisible: next.isCustomerVisible,
        isActive: next.isActive,
        updatedAt: now,
      })
      .where(eq(variants.id, variantId))
      .run();
  } catch (err) {
    if (String(err).includes("UNIQUE constraint failed")) {
      throw new HTTPException(409, { message: "duplicate_sku" });
    }
    throw err;
  }
  writeAuditEvent(tx, {
    entityType: "variant",
    entityId: variantId,
    action: "updated",
    actorId: actor.userId,
    actorType: "staff",
    before: { ...existing },
    after: { ...next },
  });
  return next;
}
