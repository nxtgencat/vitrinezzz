import { randomUUIDv7 } from "bun";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { invoiceItems, invoices, orders, returnItems, returns } from "../db/schema/orders";
import { purchaseBillItems, purchaseBills } from "../db/schema/purchasing";
import { db } from "../lib/db";
import type { Tx } from "../lib/db";
import { freshDocNumber } from "../lib/doc-number";
import type { InvoiceAllocation } from "../db/schema/orders";
import { requireCapability } from "./rbac";
import type { CustomerActor, StaffActor } from "./rbac";
import { writeOrderEvent } from "./sales";
import { sumStockAtBatch, writeMovement } from "./stock";

type ReturnRow = typeof returns.$inferSelect;
type ReturnItemRow = typeof returnItems.$inferSelect;
type InvoiceRow = typeof invoices.$inferSelect;
type BillRow = typeof purchaseBills.$inferSelect;

export type ReturnItemInput = {
  originalItemId: string;
  quantity: number;
};

type ReturnSource = { type: "sales"; order: OrderRow; invoice: InvoiceRow } | { type: "purchase"; bill: BillRow };

type OrderRow = typeof orders.$inferSelect;

/** A return line's share of its original line's tax, pro-rated by quantity —
 * the invoice/purchase-bill line's `taxAmountPaise` is the whole line's tax. */
function proportionalTax(originalQuantity: number, originalTaxPaise: number, returnQuantity: number): number {
  return Math.round((originalTaxPaise * returnQuantity) / originalQuantity);
}

function assertOrderIssuedInvoice(tx: Tx, orderId: string): InvoiceRow {
  const invoice = tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.orderId, orderId), eq(invoices.status, "issued")))
    .get();
  if (!invoice) throw new HTTPException(404, { message: "not_found" });
  return invoice;
}

function assertReturnSource(tx: Tx, header: ReturnRow): ReturnSource {
  if (header.returnType === "sales") {
    const order = tx.select().from(orders).where(eq(orders.id, header.orderId!)).get();
    if (!order) throw new HTTPException(404, { message: "not_found" });
    return { type: "sales", order, invoice: assertOrderIssuedInvoice(tx, order.id) };
  }
  const bill = tx.select().from(purchaseBills).where(eq(purchaseBills.id, header.purchaseBillId!)).get();
  if (!bill) throw new HTTPException(404, { message: "not_found" });
  return { type: "purchase", bill };
}

/**
 * Validates a return line set against the original document and resolves every
 * line to its snapshot (schema.md §6.6): each `originalItemId` must be a line
 * of that document (404), quantities in 1..original (400), no duplicates (400),
 * and sales returns may not reference custom lines (`return_items.variantId`
 * is NOT NULL by schema). Money is copied from the original line here and
 * re-snapshotted at confirm (purchase value basis = the bill's unit cost).
 */
function resolveReturnLines(tx: Tx, source: ReturnSource, items: ReturnItemInput[]): ReturnItemRow[] {
  const seen = new Set<string>();
  return items.map((item) => {
    if (seen.has(item.originalItemId)) {
      throw new HTTPException(400, { message: "duplicate line" });
    }
    seen.add(item.originalItemId);
    if (source.type === "sales") {
      const original = tx
        .select()
        .from(invoiceItems)
        .where(and(eq(invoiceItems.id, item.originalItemId), eq(invoiceItems.invoiceId, source.invoice.id)))
        .get();
      if (!original) throw new HTTPException(404, { message: "not_found" });
      if (original.variantId === null || original.isCustomItem === 1) {
        throw new HTTPException(400, { message: "custom line returns not supported" });
      }
      if (item.quantity < 1 || item.quantity > original.quantity) {
        throw new HTTPException(400, { message: "quantity out of range" });
      }
      return {
        id: randomUUIDv7(),
        returnId: "",
        variantId: original.variantId,
        originalItemId: original.id,
        quantity: item.quantity,
        unitPricePaise: original.unitPricePaise,
        taxAmountPaise: proportionalTax(original.quantity, original.taxAmountPaise, item.quantity),
      };
    }
    const original = tx
      .select()
      .from(purchaseBillItems)
      .where(and(eq(purchaseBillItems.id, item.originalItemId), eq(purchaseBillItems.purchaseBillId, source.bill.id)))
      .get();
    if (!original) throw new HTTPException(404, { message: "not_found" });
    if (item.quantity < 1 || item.quantity > original.quantity) {
      throw new HTTPException(400, { message: "quantity out of range" });
    }
    return {
      id: randomUUIDv7(),
      returnId: "",
      variantId: original.variantId,
      originalItemId: original.id,
      quantity: item.quantity,
      unitPricePaise: original.unitCostPaise,
      taxAmountPaise: proportionalTax(original.quantity, original.taxAmountPaise, item.quantity),
    };
  });
}

function insertReturnDraft(
  tx: Tx,
  input: { returnType: "sales" | "purchase"; orderId: string | null; purchaseBillId: string | null; outletId: string; lines: ReturnItemRow[] },
): { returns: ReturnRow; items: ReturnItemRow[] } {
  const now = Date.now();
  const returnNumber = freshDocNumber("RT", (n) =>
    Boolean(tx.select({ id: returns.id }).from(returns).where(eq(returns.returnNumber, n)).get()),
  );
  const header: ReturnRow = {
    id: randomUUIDv7(),
    returnNumber,
    returnType: input.returnType,
    orderId: input.orderId,
    purchaseBillId: input.purchaseBillId,
    outletId: input.outletId,
    status: "draft",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  tx.insert(returns).values(header).run();
  const saved: ReturnItemRow[] = input.lines.map((row) => {
    const full = { ...row, returnId: header.id };
    tx.insert(returnItems).values(full).run();
    return full;
  });
  return { returns: header, items: saved };
}

/**
 * Draft customer sales return (`api.md` §9, `schema.md` §7). Only a `confirmed`
 * order of the session customer with an `issued` invoice can be returned
 * against; each line must reference an `invoice_items` row of that invoice and
 * request 1..original quantity. Custom lines cannot be returned.
 *
 * Draft creation plays no stock and emits no fact rows or events (I11).
 */
export function createSalesReturn(
  tx: Tx,
  customer: CustomerActor,
  input: { orderId: string; items: ReturnItemInput[] },
): { returns: ReturnRow; items: ReturnItemRow[] } {
  const order = tx
    .select()
    .from(orders)
    .where(and(eq(orders.id, input.orderId), eq(orders.customerId, customer.customerId)))
    .get();
  if (!order) throw new HTTPException(404, { message: "not_found" });
  if (order.status !== "confirmed") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  const invoice = assertOrderIssuedInvoice(tx, order.id);
  const lines = resolveReturnLines(tx, { type: "sales", order, invoice }, input.items);
  return insertReturnDraft(tx, { returnType: "sales", orderId: order.id, purchaseBillId: null, outletId: order.outletId, lines });
}

/**
 * Staff return draft (`api.md` §8) — both types, exactly one of
 * `orderId`/`purchaseBillId` matching `returnType` (XOR, schema.md §14 rule 1).
 * Sales: the order must be `confirmed` with an `issued` invoice (else
 * `409 invalid_transition`/404); purchase: the bill must be `issued`. The
 * outlet is the document's own. Draft creation plays no stock.
 */
export function createReturn(
  tx: Tx,
  actor: StaffActor,
  input: { returnType: "sales" | "purchase"; orderId?: string | null; purchaseBillId?: string | null; items: ReturnItemInput[] },
): { returns: ReturnRow; items: ReturnItemRow[] } {
  let source: ReturnSource;
  if (input.returnType === "sales") {
    if (!input.orderId) throw new HTTPException(400, { message: "exactly one document link required" });
    const order = tx.select().from(orders).where(eq(orders.id, input.orderId)).get();
    if (!order) throw new HTTPException(404, { message: "not_found" });
    if (order.status !== "confirmed") {
      throw new HTTPException(409, { message: "invalid_transition" });
    }
    const invoice = assertOrderIssuedInvoice(tx, order.id);
    requireCapability(actor, "canManageReturns", order.outletId);
    source = { type: "sales", order, invoice };
    const lines = resolveReturnLines(tx, source, input.items);
    return insertReturnDraft(tx, { returnType: "sales", orderId: order.id, purchaseBillId: null, outletId: order.outletId, lines });
  }
  if (!input.purchaseBillId) throw new HTTPException(400, { message: "exactly one document link required" });
  const bill = tx.select().from(purchaseBills).where(eq(purchaseBills.id, input.purchaseBillId)).get();
  if (!bill) throw new HTTPException(404, { message: "not_found" });
  if (bill.status !== "issued") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  requireCapability(actor, "canManageReturns", bill.outletId);
  source = { type: "purchase", bill };
  const lines = resolveReturnLines(tx, source, input.items);
  return insertReturnDraft(tx, { returnType: "purchase", orderId: null, purchaseBillId: bill.id, outletId: bill.outletId, lines });
}

/**
 * Draft-only, versioned, full-replace edit of a return's line set (race R5),
 * re-validated against the original document. `409 stale_version` on conflict,
 * `409 invalid_transition` on a confirmed/voided return.
 */
export function updateReturn(
  tx: Tx,
  actor: StaffActor,
  returnId: string,
  input: { items: ReturnItemInput[]; version: number },
): { returns: ReturnRow; items: ReturnItemRow[] } {
  const existing = tx.select().from(returns).where(eq(returns.id, returnId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManageReturns", existing.outletId);
  if (existing.status !== "draft") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  if (input.version !== existing.version) {
    throw new HTTPException(409, { message: "stale_version" });
  }
  const source = assertReturnSource(tx, existing);
  const lines = resolveReturnLines(tx, source, input.items);
  const now = Date.now();
  tx.update(returns)
    .set({ version: existing.version + 1, updatedAt: now })
    .where(and(eq(returns.id, returnId), eq(returns.version, input.version)))
    .run();
  tx.delete(returnItems).where(eq(returnItems.returnId, returnId)).run();
  const saved = lines.map((row) => {
    const full = { ...row, returnId };
    tx.insert(returnItems).values(full).run();
    return full;
  });
  return { returns: { ...existing, version: existing.version + 1, updatedAt: now }, items: saved };
}

/**
 * Quantity of `originalItemId` already committed by **confirmed** returns of
 * the same type against the same original document — the R4 cap input. All
 * recomputed in-transaction, never cached.
 */
function priorConfirmedQuantity(tx: Tx, returnType: string, doc: { orderId?: string | null; purchaseBillId?: string | null }, originalItemId: string): number {
  const docCond = returnType === "sales" ? eq(returns.orderId, doc.orderId ?? "") : eq(returns.purchaseBillId, doc.purchaseBillId ?? "");
  const rows = tx
    .select({ quantity: returnItems.quantity })
    .from(returnItems)
    .innerJoin(returns, eq(returns.id, returnItems.returnId))
    .where(and(eq(returnItems.originalItemId, originalItemId), eq(returns.status, "confirmed"), eq(returns.returnType, returnType), docCond))
    .all();
  return rows.reduce((s, r) => s + r.quantity, 0);
}

/**
 * Sales restock mirrors the original allocations exactly (`architecture.md`
 * §4.6): the invoice line's stored `allocations` JSON (`[{batchId, qty}]`) is
 * consumed greedily in order for the returned quantity, one `return_in`
 * movement per touched batch. Because each line's return ≤ its sold quantity,
 * per-batch restock can never exceed per-batch sales — never-negative holds by
 * construction.
 */
function salesReturnMovements(tx: Tx, invoice: InvoiceRow, line: ReturnItemRow, allocations: InvoiceAllocation[]): void {
  let remaining = line.quantity;
  for (const allocation of allocations) {
    if (remaining <= 0) break;
    const take = Math.min(allocation.qty, remaining);
    writeMovement(tx, {
      variantId: line.variantId,
      outletId: invoice.outletId,
      batchId: allocation.batchId,
      delta: take,
      reason: "return_in",
      sourceType: "return",
      sourceId: line.returnId,
    });
    remaining -= take;
  }
}

/**
 * `draft → confirmed` (`api.md` §8, R4): per-line returnable is re-derived
 * in-tx as `original − Σ confirmed return lines referencing it`; over →
 * `409 over_return`, whole document rolls back, zero movements. Sales restock
 * mirrors the original allocations (`return_in`); purchase de-stocks the
 * bill's resolved batch (`return_out`, gated in-tx on available stock — I1).
 * Values are re-snapshotted from the original line (schema.md §6.6), and a
 * sales return writes its `return.confirmed` order event (I8).
 */
export function confirmReturn(tx: Tx, actor: StaffActor, returnId: string): ReturnRow {
  const existing = tx.select().from(returns).where(eq(returns.id, returnId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManageReturns", existing.outletId);
  if (existing.status !== "draft") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  const lines = tx
    .select()
    .from(returnItems)
    .where(eq(returnItems.returnId, returnId))
    .orderBy(asc(returnItems.id))
    .all();
  if (lines.length === 0) {
    throw new HTTPException(400, { message: "return has no lines" });
  }

  const source = assertReturnSource(tx, existing);
  let orderId: string | null = null;
  if (source.type === "sales") {
    orderId = source.order.id;
    for (const line of lines) {
      const original = tx.select().from(invoiceItems).where(eq(invoiceItems.id, line.originalItemId)).get();
      if (!original || original.invoiceId !== source.invoice.id) {
        throw new HTTPException(404, { message: "not_found" });
      }
      const returnable = original.quantity - priorConfirmedQuantity(tx, "sales", { orderId: source.order.id }, original.id);
      if (line.quantity > returnable) {
        throw new HTTPException(409, { message: "over_return" });
      }
      salesReturnMovements(tx, source.invoice, line, original.allocations);
      tx.update(returnItems)
        .set({ unitPricePaise: original.unitPricePaise, taxAmountPaise: proportionalTax(original.quantity, original.taxAmountPaise, line.quantity) })
        .where(eq(returnItems.id, line.id))
        .run();
    }
  } else {
    if (source.bill.status !== "issued") {
      throw new HTTPException(409, { message: "invalid_transition" });
    }
    for (const line of lines) {
      const original = tx.select().from(purchaseBillItems).where(eq(purchaseBillItems.id, line.originalItemId)).get();
      if (!original || original.purchaseBillId !== source.bill.id) {
        throw new HTTPException(404, { message: "not_found" });
      }
      const returnable = original.quantity - priorConfirmedQuantity(tx, "purchase", { purchaseBillId: source.bill.id }, original.id);
      if (line.quantity > returnable) {
        throw new HTTPException(409, { message: "over_return" });
      }
      if (!original.batchId) {
        throw new HTTPException(400, { message: "batch not resolved" });
      }
      if (sumStockAtBatch(tx, line.variantId, source.bill.outletId, original.batchId) < line.quantity) {
        throw new HTTPException(409, { message: "insufficient_stock" });
      }
      writeMovement(tx, {
        variantId: line.variantId,
        outletId: source.bill.outletId,
        batchId: original.batchId,
        delta: -line.quantity,
        reason: "return_out",
        sourceType: "return",
        sourceId: returnId,
      });
      tx.update(returnItems)
        .set({ unitPricePaise: original.unitCostPaise, taxAmountPaise: proportionalTax(original.quantity, original.taxAmountPaise, line.quantity) })
        .where(eq(returnItems.id, line.id))
        .run();
    }
  }

  const now = Date.now();
  tx.update(returns)
    .set({ status: "confirmed", updatedAt: now })
    .where(eq(returns.id, returnId))
    .run();
  if (orderId) {
    writeOrderEvent(tx, orderId, "return.confirmed", { status: "confirmed", returnId, returnType: "sales" }, actor.userId, "staff");
  }
  return { ...existing, status: "confirmed", updatedAt: now };
}

/** `void` exists only on drafts (`architecture.md` §4.7) — a draft return has
 * no movements, so voiding never touches stock. */
export function voidReturn(tx: Tx, actor: StaffActor, returnId: string): ReturnRow {
  const existing = tx.select().from(returns).where(eq(returns.id, returnId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManageReturns", existing.outletId);
  if (existing.status !== "draft") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  const now = Date.now();
  tx.update(returns)
    .set({ status: "void", updatedAt: now })
    .where(eq(returns.id, returnId))
    .run();
  return { ...existing, status: "void", updatedAt: now };
}

export type ReturnListOptions = {
  returnType?: string;
  status?: string;
  page: number;
  pageSize: number;
};

export function listReturns(opts: ReturnListOptions): { rows: ReturnRow[]; total: number } {
  const conditions = [];
  if (opts.returnType) conditions.push(eq(returns.returnType, opts.returnType));
  if (opts.status) conditions.push(eq(returns.status, opts.status));
  const where = and(...conditions);
  const total = db.select({ n: count() }).from(returns).where(where).get()?.n ?? 0;
  const rows = db
    .select()
    .from(returns)
    .where(where)
    .orderBy(desc(returns.createdAt), desc(returns.id))
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize)
    .all();
  return { rows, total };
}

export function getReturn(returnId: string): (ReturnRow & { items: ReturnItemRow[] }) | null {
  const header = db.select().from(returns).where(eq(returns.id, returnId)).get();
  if (!header) return null;
  const items = db
    .select()
    .from(returnItems)
    .where(eq(returnItems.returnId, returnId))
    .orderBy(asc(returnItems.id))
    .all();
  return { ...header, items };
}