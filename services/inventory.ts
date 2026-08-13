import { randomUUIDv7 } from "bun";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { batches, variants } from "../db/schema/catalog";
import {
  adjustmentItems,
  adjustments,
  stockTransferItems,
  stockTransfers,
} from "../db/schema/inventory";
import { outlets } from "../db/schema/org";
import { db } from "../lib/db";
import type { Tx } from "../lib/db";
import { freshDocNumber } from "../lib/doc-number";
import { sumStockAtBatch, writeMovement } from "./stock";
import type { StaffActor } from "./rbac";
import { requireCapability } from "./rbac";

type TransferRow = typeof stockTransfers.$inferSelect;
type TransferItemRow = typeof stockTransferItems.$inferSelect;
type AdjustmentRow = typeof adjustments.$inferSelect;
type AdjustmentItemRow = typeof adjustmentItems.$inferSelect;

export type TransferLineInput = {
  variantId: string;
  batchId: string;
  quantity: number;
};

export type CreateTransferInput = {
  fromOutletId: string;
  toOutletId: string;
  items: TransferLineInput[];
};

export type UpdateTransferInput = CreateTransferInput & { version: number };

function assertOutlets(tx: Tx, fromOutletId: string, toOutletId: string): void {
  const from = tx.select({ id: outlets.id }).from(outlets).where(eq(outlets.id, fromOutletId)).get();
  if (!from) throw new HTTPException(404, { message: "not_found" });
  const to = tx.select({ id: outlets.id }).from(outlets).where(eq(outlets.id, toOutletId)).get();
  if (!to) throw new HTTPException(404, { message: "not_found" });
  if (fromOutletId === toOutletId) {
    throw new HTTPException(400, { message: "same outlet" });
  }
}

/**
 * Validates a draft's line set: every variant and batch must exist, the batch
 * must belong to the line's variant (a client pairing a batch to the wrong
 * variant is a client bug), the `(variantId, batchId)` pairs must be distinct
 * within the document, and the quantity must satisfy the document's policy
 * (`"positive"` for transfers, `"nonzero"` for adjustments, which carry signed
 * quantities). Returns the loaded batch rows so the caller can reuse them
 * (unitValuePaise for adjustments).
 */
function assertTransferLines(
  tx: Tx,
  items: TransferLineInput[],
  quantityPolicy: "positive" | "nonzero",
): { batchId: string; costPricePaise: number }[] {
  const seen = new Set<string>();
  const batchesOf: { batchId: string; costPricePaise: number }[] = [];
  for (const line of items) {
    if (quantityPolicy === "positive" && line.quantity < 1) {
      throw new HTTPException(400, { message: "quantity must be positive" });
    }
    if (quantityPolicy === "nonzero" && line.quantity === 0) {
      throw new HTTPException(400, { message: "quantity must be non-zero" });
    }
    const pair = `${line.variantId}\u0000${line.batchId}`;
    if (seen.has(pair)) {
      throw new HTTPException(400, { message: "duplicate line" });
    }
    seen.add(pair);
    const variant = tx.select({ id: variants.id }).from(variants).where(eq(variants.id, line.variantId)).get();
    if (!variant) throw new HTTPException(404, { message: "not_found" });
    const batch = tx.select().from(batches).where(eq(batches.id, line.batchId)).get();
    if (!batch) throw new HTTPException(404, { message: "not_found" });
    if (batch.variantId !== line.variantId) {
      throw new HTTPException(400, { message: "batch variant mismatch" });
    }
    batchesOf.push({ batchId: batch.id, costPricePaise: batch.costPricePaise });
  }
  return batchesOf;
}

function insertTransferItems(tx: Tx, transferId: string, items: TransferLineInput[]): TransferItemRow[] {
  return items.map((line) => {
    const row: TransferItemRow = {
      id: randomUUIDv7(),
      stockTransferId: transferId,
      variantId: line.variantId,
      batchId: line.batchId,
      quantity: line.quantity,
    };
    tx.insert(stockTransferItems).values(row).run();
    return row;
  });
}

/**
 * Draft stock transfer (`api.md` §4). A transfer spans two outlets, so it
 * declares no single outlet scope — the strict scope rule (`architecture.md`
 * §4.14) denies outlet-scoped roles entirely (403); only global roles may
 * move stock between outlets. `fromOutletId ≠ toOutletId` is enforced here
 * (400), never at the DB.
 */
export function createTransfer(tx: Tx, actor: StaffActor, input: CreateTransferInput): TransferRow & { items: TransferItemRow[] } {
  requireCapability(actor, "canManageInventory");
  assertOutlets(tx, input.fromOutletId, input.toOutletId);
  assertTransferLines(tx, input.items, "positive");
  const now = Date.now();
  const transferNumber = freshDocNumber("TR", (n) =>
    Boolean(tx.select({ id: stockTransfers.id }).from(stockTransfers).where(eq(stockTransfers.transferNumber, n)).get()),
  );
  const row: TransferRow = {
    id: randomUUIDv7(),
    transferNumber,
    fromOutletId: input.fromOutletId,
    toOutletId: input.toOutletId,
    status: "draft",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  tx.insert(stockTransfers).values(row).run();
  const items = insertTransferItems(tx, row.id, input.items);
  return { ...row, items };
}

/**
 * Draft-only, versioned edit (`api.md` §4, race R5): the client sends the
 * version it last saw; anything else is a `409 stale_version` (0 rows
 * changed). The whole line set is replaced in the same transaction as the
 * header update.
 */
export function updateTransfer(
  tx: Tx,
  actor: StaffActor,
  transferId: string,
  input: UpdateTransferInput,
): TransferRow & { items: TransferItemRow[] } {
  requireCapability(actor, "canManageInventory");
  const existing = tx.select().from(stockTransfers).where(eq(stockTransfers.id, transferId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  if (existing.status !== "draft") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  if (input.version !== existing.version) {
    throw new HTTPException(409, { message: "stale_version" });
  }
  assertOutlets(tx, input.fromOutletId, input.toOutletId);
  assertTransferLines(tx, input.items, "positive");
  const now = Date.now();
  tx.update(stockTransfers)
    .set({
      fromOutletId: input.fromOutletId,
      toOutletId: input.toOutletId,
      version: existing.version + 1,
      updatedAt: now,
    })
    .where(and(eq(stockTransfers.id, transferId), eq(stockTransfers.version, input.version)))
    .run();
  tx.delete(stockTransferItems).where(eq(stockTransferItems.stockTransferId, transferId)).run();
  const items = insertTransferItems(tx, transferId, input.items);
  const next: TransferRow = { ...existing, fromOutletId: input.fromOutletId, toOutletId: input.toOutletId, version: existing.version + 1, updatedAt: now };
  return { ...next, items };
}

/**
 * `draft → confirmed`, whole-document atomic (`architecture.md` §4.7): every
 * line is gated against `SUM(stock_movements.delta)` at the source
 * outlet/batch, re-derived in-transaction (R2 mechanism, §4.3) — one
 * insufficient line throws and rolls back the entire document, zero movements
 * survive. On success each line writes a paired
 * `transfer_out`@source / `transfer_in`@destination against the same batch.
 * Confirmed transfers are terminal: re-confirm → `409 invalid_transition`.
 */
export function confirmTransfer(tx: Tx, actor: StaffActor, transferId: string): TransferRow {
  requireCapability(actor, "canManageInventory");
  const existing = tx.select().from(stockTransfers).where(eq(stockTransfers.id, transferId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  if (existing.status !== "draft") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  const lines = tx
    .select()
    .from(stockTransferItems)
    .where(eq(stockTransferItems.stockTransferId, transferId))
    .orderBy(asc(stockTransferItems.id))
    .all();
  for (const line of lines) {
    const available = sumStockAtBatch(tx, line.variantId, existing.fromOutletId, line.batchId);
    if (available < line.quantity) {
      throw new HTTPException(409, { message: "insufficient_stock" });
    }
  }
  for (const line of lines) {
    writeMovement(tx, {
      variantId: line.variantId,
      outletId: existing.fromOutletId,
      batchId: line.batchId,
      delta: -line.quantity,
      reason: "transfer_out",
      sourceType: "transfer",
      sourceId: transferId,
    });
    writeMovement(tx, {
      variantId: line.variantId,
      outletId: existing.toOutletId,
      batchId: line.batchId,
      delta: line.quantity,
      reason: "transfer_in",
      sourceType: "transfer",
      sourceId: transferId,
    });
  }
  const now = Date.now();
  tx.update(stockTransfers)
    .set({ status: "confirmed", updatedAt: now })
    .where(eq(stockTransfers.id, transferId))
    .run();
  return { ...existing, status: "confirmed", updatedAt: now };
}

/**
 * `void` exists only on drafts (`architecture.md` §4.7) — a confirmed
 * transfer is unwound by a reverse transfer, never by voiding.
 */
export function voidTransfer(tx: Tx, actor: StaffActor, transferId: string): TransferRow {
  requireCapability(actor, "canManageInventory");
  const existing = tx.select().from(stockTransfers).where(eq(stockTransfers.id, transferId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  if (existing.status !== "draft") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  const now = Date.now();
  tx.update(stockTransfers)
    .set({ status: "void", updatedAt: now })
    .where(eq(stockTransfers.id, transferId))
    .run();
  return { ...existing, status: "void", updatedAt: now };
}

export type TransferListOptions = {
  status?: string;
  page: number;
  pageSize: number;
};

export function listTransfers(opts: TransferListOptions): { rows: TransferRow[]; total: number } {
  const conditions = [];
  if (opts.status) conditions.push(eq(stockTransfers.status, opts.status));
  const where = and(...conditions);
  const total = db.select({ n: count() }).from(stockTransfers).where(where).get()?.n ?? 0;
  const rows = db
    .select()
    .from(stockTransfers)
    .where(where)
    .orderBy(desc(stockTransfers.createdAt), desc(stockTransfers.id))
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize)
    .all();
  return { rows, total };
}

export function getTransfer(transferId: string): (TransferRow & { items: TransferItemRow[] }) | null {
  const header = db.select().from(stockTransfers).where(eq(stockTransfers.id, transferId)).get();
  if (!header) return null;
  const items = db
    .select()
    .from(stockTransferItems)
    .where(eq(stockTransferItems.stockTransferId, transferId))
    .orderBy(asc(stockTransferItems.id))
    .all();
  return { ...header, items };
}

export type AdjustmentLineInput = {
  variantId: string;
  batchId: string;
  quantity: number;
};

export type CreateAdjustmentInput = {
  outletId: string;
  reason: string;
  items: AdjustmentLineInput[];
};

export type UpdateAdjustmentInput = CreateAdjustmentInput & { version: number };

function insertAdjustmentItems(
  tx: Tx,
  adjustmentId: string,
  items: AdjustmentLineInput[],
  batchesOf: { batchId: string; costPricePaise: number }[],
): AdjustmentItemRow[] {
  return items.map((line, i) => {
    const row: AdjustmentItemRow = {
      id: randomUUIDv7(),
      adjustmentId,
      variantId: line.variantId,
      batchId: line.batchId,
      quantity: line.quantity,
      unitValuePaise: batchesOf[i]!.costPricePaise,
    };
    tx.insert(adjustmentItems).values(row).run();
    return row;
  });
}

/**
 * Draft adjustment (`api.md` §4). Lines carry a signed `quantity` (positive =
 * `adjustment_in`, negative = `adjustment_out`). `unitValuePaise` is never
 * client-supplied: it is derived server-side from the batch's
 * `costPricePaise` at line-create time (`schema.md` §4.6) — stock valuation is
 * a non-goal, the column only records the value at adjustment time. Scoped to
 * the adjustment's own outlet.
 */
export function createAdjustment(tx: Tx, actor: StaffActor, input: CreateAdjustmentInput): AdjustmentRow & { items: AdjustmentItemRow[] } {
  requireCapability(actor, "canManageInventory", input.outletId);
  const outlet = tx.select({ id: outlets.id }).from(outlets).where(eq(outlets.id, input.outletId)).get();
  if (!outlet) throw new HTTPException(404, { message: "not_found" });
  const batchesOf = assertTransferLines(tx, input.items, "nonzero");
  const now = Date.now();
  const adjustmentNumber = freshDocNumber("AJ", (n) =>
    Boolean(tx.select({ id: adjustments.id }).from(adjustments).where(eq(adjustments.adjustmentNumber, n)).get()),
  );
  const row: AdjustmentRow = {
    id: randomUUIDv7(),
    adjustmentNumber,
    outletId: input.outletId,
    reason: input.reason,
    status: "draft",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  tx.insert(adjustments).values(row).run();
  const items = insertAdjustmentItems(tx, row.id, input.items, batchesOf);
  return { ...row, items };
}

/**
 * Draft-only, versioned edit (race R5). Scoped to the draft's new outlet —
 * an outlet-scoped actor may only edit a draft that stays in their outlet.
 */
export function updateAdjustment(
  tx: Tx,
  actor: StaffActor,
  adjustmentId: string,
  input: UpdateAdjustmentInput,
): AdjustmentRow & { items: AdjustmentItemRow[] } {
  requireCapability(actor, "canManageInventory", input.outletId);
  const existing = tx.select().from(adjustments).where(eq(adjustments.id, adjustmentId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  if (existing.status !== "draft") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  if (input.version !== existing.version) {
    throw new HTTPException(409, { message: "stale_version" });
  }
  const outlet = tx.select({ id: outlets.id }).from(outlets).where(eq(outlets.id, input.outletId)).get();
  if (!outlet) throw new HTTPException(404, { message: "not_found" });
  const batchesOf = assertTransferLines(tx, input.items, "nonzero");
  const now = Date.now();
  tx.update(adjustments)
    .set({ outletId: input.outletId, reason: input.reason, version: existing.version + 1, updatedAt: now })
    .where(and(eq(adjustments.id, adjustmentId), eq(adjustments.version, input.version)))
    .run();
  tx.delete(adjustmentItems).where(eq(adjustmentItems.adjustmentId, adjustmentId)).run();
  const items = insertAdjustmentItems(tx, adjustmentId, input.items, batchesOf);
  const next: AdjustmentRow = { ...existing, outletId: input.outletId, reason: input.reason, version: existing.version + 1, updatedAt: now };
  return { ...next, items };
}

/**
 * `draft → confirmed` (`architecture.md` §4.7): positive lines write
 * `adjustment_in` unconditionally; negative lines are gated in-transaction
 * against the batch's available stock (R2 mechanism) — a shortage throws and
 * rolls back the whole document, zero movements survive. Terminal:
 * re-confirm → `409 invalid_transition`.
 */
export function confirmAdjustment(tx: Tx, actor: StaffActor, adjustmentId: string): AdjustmentRow {
  const existing = tx.select().from(adjustments).where(eq(adjustments.id, adjustmentId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManageInventory", existing.outletId);
  if (existing.status !== "draft") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  const lines = tx
    .select()
    .from(adjustmentItems)
    .where(eq(adjustmentItems.adjustmentId, adjustmentId))
    .orderBy(asc(adjustmentItems.id))
    .all();
  for (const line of lines) {
    if (line.quantity < 0) {
      const available = sumStockAtBatch(tx, line.variantId, existing.outletId, line.batchId);
      if (available < -line.quantity) {
        throw new HTTPException(409, { message: "insufficient_stock" });
      }
    }
  }
  for (const line of lines) {
    const reason = line.quantity >= 0 ? "adjustment_in" : "adjustment_out";
    writeMovement(tx, {
      variantId: line.variantId,
      outletId: existing.outletId,
      batchId: line.batchId,
      delta: line.quantity,
      reason,
      sourceType: "adjustment",
      sourceId: adjustmentId,
    });
  }
  const now = Date.now();
  tx.update(adjustments)
    .set({ status: "confirmed", updatedAt: now })
    .where(eq(adjustments.id, adjustmentId))
    .run();
  return { ...existing, status: "confirmed", updatedAt: now };
}

export function voidAdjustment(tx: Tx, actor: StaffActor, adjustmentId: string): AdjustmentRow {
  const existing = tx.select().from(adjustments).where(eq(adjustments.id, adjustmentId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManageInventory", existing.outletId);
  if (existing.status !== "draft") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  const now = Date.now();
  tx.update(adjustments)
    .set({ status: "void", updatedAt: now })
    .where(eq(adjustments.id, adjustmentId))
    .run();
  return { ...existing, status: "void", updatedAt: now };
}

export type AdjustmentListOptions = {
  status?: string;
  page: number;
  pageSize: number;
};

export function listAdjustments(opts: AdjustmentListOptions): { rows: AdjustmentRow[]; total: number } {
  const conditions = [];
  if (opts.status) conditions.push(eq(adjustments.status, opts.status));
  const where = and(...conditions);
  const total = db.select({ n: count() }).from(adjustments).where(where).get()?.n ?? 0;
  const rows = db
    .select()
    .from(adjustments)
    .where(where)
    .orderBy(desc(adjustments.createdAt), desc(adjustments.id))
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize)
    .all();
  return { rows, total };
}

export function getAdjustment(adjustmentId: string): (AdjustmentRow & { items: AdjustmentItemRow[] }) | null {
  const header = db.select().from(adjustments).where(eq(adjustments.id, adjustmentId)).get();
  if (!header) return null;
  const items = db
    .select()
    .from(adjustmentItems)
    .where(eq(adjustmentItems.adjustmentId, adjustmentId))
    .orderBy(asc(adjustmentItems.id))
    .all();
  return { ...header, items };
}
