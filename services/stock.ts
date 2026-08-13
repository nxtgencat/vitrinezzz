import { randomUUIDv7 } from "bun";
import { and, asc, count, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { batches, variants } from "../db/schema/catalog";
import { stockLevels, stockMovements } from "../db/schema/inventory";
import { db } from "../lib/db";
import type { Tx } from "../lib/db";
import { writeAuditEvent } from "./audit";
import { requireCapability } from "./rbac";
import type { StaffActor } from "./rbac";

export const STOCK_REASONS = [
  "initial",
  "purchase",
  "sale",
  "return_in",
  "return_out",
  "transfer_out",
  "transfer_in",
  "adjustment_in",
  "adjustment_out",
] as const;

export type StockReason = (typeof STOCK_REASONS)[number];

type BatchRow = typeof batches.$inferSelect;

export type MovementInput = {
  variantId: string;
  outletId: string;
  batchId: string;
  delta: number;
  reason: StockReason;
  sourceType: string;
  sourceId?: string | null;
  createdAt?: number;
};

/**
 * The one stock write path and the one projection maintainer
 * (`architecture.md` §4.6): inserts the `stock_movements` fact row, then
 * upserts `stock_levels(variantId, outletId, batchId)` by incrementing the
 * cached quantity. `lastMovementId`/`updatedAt` are the movement's own
 * id/createdAt, which is exactly what a `(createdAt, id)`-ordered replay
 * recomputes — `verify-stock` proves the two agree byte-for-byte. This is the
 * only function in the codebase that writes to either table; stock gates never
 * trust the cache, they re-derive `SUM(stock_movements.delta)` in-transaction
 * (R2, §4.3) before calling this.
 */
export function writeMovement(tx: Tx, input: MovementInput): string {
  const id = randomUUIDv7();
  const createdAt = input.createdAt ?? Date.now();
  tx.insert(stockMovements)
    .values({
      id,
      variantId: input.variantId,
      outletId: input.outletId,
      batchId: input.batchId,
      delta: input.delta,
      reason: input.reason,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      createdAt,
    })
    .run();
  const key = { variantId: input.variantId, outletId: input.outletId, batchId: input.batchId };
  const existing = tx
    .select()
    .from(stockLevels)
    .where(and(eq(stockLevels.variantId, key.variantId), eq(stockLevels.outletId, key.outletId), eq(stockLevels.batchId, key.batchId)))
    .get();
  if (existing) {
    tx.update(stockLevels)
      .set({ quantity: existing.quantity + input.delta, lastMovementId: id, updatedAt: createdAt })
      .where(and(eq(stockLevels.variantId, key.variantId), eq(stockLevels.outletId, key.outletId), eq(stockLevels.batchId, key.batchId)))
      .run();
  } else {
    tx.insert(stockLevels)
      .values({ ...key, quantity: input.delta, lastMovementId: id, updatedAt: createdAt })
      .run();
  }
  return id;
}

/** Decision read — available stock of one batch at one outlet, re-derived from
 * the fact table in-transaction (never the projection cache, §4.6). */
export function sumStockAtBatch(tx: Tx, variantId: string, outletId: string, batchId: string): number {
  const row = tx
    .select({ total: sql<number>`coalesce(sum(${stockMovements.delta}), 0)` })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.variantId, variantId),
        eq(stockMovements.outletId, outletId),
        eq(stockMovements.batchId, batchId),
      ),
    )
    .get();
  return row?.total ?? 0;
}

/** Decision read — available stock of a variant at an outlet across all
 * batches, re-derived from the fact table in-transaction (R2 gate, §4.3). */
export function sumStock(tx: Tx, variantId: string, outletId: string): number {
  const row = tx
    .select({ total: sql<number>`coalesce(sum(${stockMovements.delta}), 0)` })
    .from(stockMovements)
    .where(and(eq(stockMovements.variantId, variantId), eq(stockMovements.outletId, outletId)))
    .get();
  return row?.total ?? 0;
}

/**
 * Decision read — per-batch holdings of a variant at an outlet, re-derived
 * from the fact table in-transaction (never the projection cache, §4.6):
 * `SUM(stock_movements.delta)` grouped by batch, joined with the batches'
 * expiry dates so the FIFO allocator (`allocateBatches`) can sort by
 * `(expiryDate ASC, nulls last)`. This is the input to every sale allocation
 * (phase 7's `issueInvoice` core).
 */
export function batchHoldings(tx: Tx, variantId: string, outletId: string): AllocatableBatch[] {
  const sums = tx
    .select({
      batchId: stockMovements.batchId,
      quantity: sql<number>`coalesce(sum(${stockMovements.delta}), 0)`,
    })
    .from(stockMovements)
    .where(and(eq(stockMovements.variantId, variantId), eq(stockMovements.outletId, outletId)))
    .groupBy(stockMovements.batchId)
    .all();
  if (sums.length === 0) return [];
  const batchIds = sums.map((s) => s.batchId);
  const batchRows = tx
    .select({ id: batches.id, expiryDate: batches.expiryDate })
    .from(batches)
    .where(inArray(batches.id, batchIds))
    .all();
  const expiryOf = new Map(batchRows.map((b) => [b.id, b.expiryDate]));
  return sums.map((s) => ({ batchId: s.batchId, quantity: s.quantity, expiryDate: expiryOf.get(s.batchId) ?? null }));
}

export type AllocatableBatch = { batchId: string; quantity: number; expiryDate: number | null };
export type BatchAllocation = { batchId: string; qty: number };

/**
 * FIFO-by-expiry allocation (`architecture.md` §4.6), pure and unit-tested.
 * Sorts the given holdings by `(expiryDate ASC, nulls last)` with a
 * deterministic `batchId` tie-break, then greedily allocates the requested
 * quantity. Returns `null` when the request cannot be fully satisfied — the
 * caller turns that into the in-tx `409 insufficient_stock` gate. Batches with
 * zero/negative holdings are skipped.
 */
export function allocateBatches(available: AllocatableBatch[], requestedQty: number): BatchAllocation[] | null {
  if (requestedQty <= 0) return [];
  const sorted = [...available].sort((a, b) => {
    const aExp = a.expiryDate ?? Number.POSITIVE_INFINITY;
    const bExp = b.expiryDate ?? Number.POSITIVE_INFINITY;
    if (aExp !== bExp) return aExp - bExp;
    return a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0;
  });
  const allocations: BatchAllocation[] = [];
  let remaining = requestedQty;
  for (const batch of sorted) {
    if (remaining <= 0) break;
    if (batch.quantity <= 0) continue;
    const take = Math.min(batch.quantity, remaining);
    allocations.push({ batchId: batch.batchId, qty: take });
    remaining -= take;
  }
  if (remaining > 0) return null;
  return allocations;
}

export type CreateBatchInput = {
  variantId: string;
  batchNumber: string;
  expiryDate?: number | null;
  costPricePaise: number;
};

/**
 * Explicit batch entry point (`api.md` §4) — batches are global per variant,
 * created here or by purchase-bill-issue's create-or-reuse (phase 6), never
 * implicitly. `UNIQUE(variantId, batchNumber)` → `409 duplicate_batch` (R6).
 */
export function createBatch(tx: Tx, actor: StaffActor, input: CreateBatchInput): BatchRow {
  requireCapability(actor, "canManageInventory");
  const variant = tx.select({ id: variants.id }).from(variants).where(eq(variants.id, input.variantId)).get();
  if (!variant) throw new HTTPException(404, { message: "not_found" });
  const dup = tx
    .select({ id: batches.id })
    .from(batches)
    .where(and(eq(batches.variantId, input.variantId), eq(batches.batchNumber, input.batchNumber)))
    .get();
  if (dup) throw new HTTPException(409, { message: "duplicate_batch" });
  const now = Date.now();
  const row: BatchRow = {
    id: randomUUIDv7(),
    variantId: input.variantId,
    batchNumber: input.batchNumber,
    expiryDate: input.expiryDate ?? null,
    costPricePaise: input.costPricePaise,
    isActive: 1,
    createdAt: now,
  };
  try {
    tx.insert(batches).values(row).run();
  } catch (err) {
    if (String(err).includes("UNIQUE constraint failed")) {
      throw new HTTPException(409, { message: "duplicate_batch" });
    }
    throw err;
  }
  writeAuditEvent(tx, {
    entityType: "batch",
    entityId: row.id,
    action: "created",
    actorId: actor.userId,
    actorType: "staff",
    before: null,
    after: { ...row },
  });
  return row;
}

export type StockLevelDisplay = {
  variantId: string;
  outletId: string;
  batchId: string;
  quantity: number;
  lastMovementId: string;
  updatedAt: number;
  variantName: string;
  variantSku: string | null;
  batchNumber: string;
  batchExpiryDate: number | null;
};

export type StockLevelListOptions = {
  outletId?: string;
  variantId?: string;
  lowStock?: number;
  page: number;
  pageSize: number;
};

/**
 * Display read of the projection (`api.md` §4) — joined with variant and batch
 * labels for the console, and explicitly never a decision source (§4.6). Reads
 * go through `db` directly; no transaction needed for a display query.
 */
export function listStockLevels(opts: StockLevelListOptions): { rows: StockLevelDisplay[]; total: number } {
  const conditions = [];
  if (opts.outletId) conditions.push(eq(stockLevels.outletId, opts.outletId));
  if (opts.variantId) conditions.push(eq(stockLevels.variantId, opts.variantId));
  if (opts.lowStock !== undefined) conditions.push(lte(stockLevels.quantity, opts.lowStock));
  const where = and(...conditions);
  const total = db.select({ n: count() }).from(stockLevels).where(where).get()?.n ?? 0;
  const rows = db
    .select({
      variantId: stockLevels.variantId,
      outletId: stockLevels.outletId,
      batchId: stockLevels.batchId,
      quantity: stockLevels.quantity,
      lastMovementId: stockLevels.lastMovementId,
      updatedAt: stockLevels.updatedAt,
      variantName: variants.name,
      variantSku: variants.sku,
      batchNumber: batches.batchNumber,
      batchExpiryDate: batches.expiryDate,
    })
    .from(stockLevels)
    .innerJoin(variants, eq(variants.id, stockLevels.variantId))
    .innerJoin(batches, eq(batches.id, stockLevels.batchId))
    .where(where)
    .orderBy(
      desc(stockLevels.updatedAt),
      asc(stockLevels.variantId),
      asc(stockLevels.outletId),
      asc(stockLevels.batchId),
    )
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize)
    .all();
  return { rows, total };
}
