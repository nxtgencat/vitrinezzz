import { randomUUIDv7 } from "bun";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { customers, products, variants } from "../db/schema/catalog";
import { orderEvents } from "../db/schema/facts";
import { invoiceCharges, invoiceItems, invoices, orders } from "../db/schema/orders";
import type { InvoiceAllocation } from "../db/schema/orders";
import { outlets } from "../db/schema/org";
import { payments } from "../db/schema/payments";
import { db } from "../lib/db";
import type { Tx } from "../lib/db";
import { freshDocNumber } from "../lib/doc-number";
import { computeLineTotalPaise, computeTaxAmountPaise } from "../lib/money";
import { requireCapability } from "./rbac";
import type { StaffActor } from "./rbac";
import { allocateBatches, batchHoldings, writeMovement } from "./stock";

type OrderRow = typeof orders.$inferSelect;
type InvoiceRow = typeof invoices.$inferSelect;
type InvoiceItemRow = typeof invoiceItems.$inferSelect;
type InvoiceChargeRow = typeof invoiceCharges.$inferSelect;

export type SaleLineInput =
  | { variantId: string; quantity: number }
  | { isCustomItem: true; name: string; quantity: number; unitPricePaise: number };

export type SaleChargeInput = { name: string; amountPaise: number };

export type ResolvedInvoiceLine = {
  variantId: string | null;
  name: string;
  quantity: number;
  unitPricePaise: number;
  taxRatePct: number;
  taxAmountPaise: number;
  lineTotalPaise: number;
  isCustomItem: number;
  allocations: InvoiceAllocation[];
};

export type InvoiceWithLines = InvoiceRow & { items: InvoiceItemRow[]; charges: InvoiceChargeRow[] };

/**
 * The one `order_events` write path (`schema.md` §9.1, invariant I8): every
 * order/invoice state transition writes ≥1 row in the same transaction as the
 * transition. `order_events` is a [FACT] table — insert-only, trigger-protected.
 */
export function writeOrderEvent(
  tx: Tx,
  orderId: string,
  type: string,
  payload: Record<string, unknown>,
  actorId: string | null,
  actorType: "staff" | "customer" | "system" | "webhook",
): void {
  tx.insert(orderEvents)
    .values({ id: randomUUIDv7(), orderId, type, payload, actorId, actorType, createdAt: Date.now() })
    .run();
}

function assertOrderParties(tx: Tx, customerId: string | null, outletId: string): void {
  const outlet = tx.select({ id: outlets.id }).from(outlets).where(eq(outlets.id, outletId)).get();
  if (!outlet) throw new HTTPException(404, { message: "not_found" });
  if (customerId) {
    const customer = tx.select({ id: customers.id }).from(customers).where(eq(customers.id, customerId)).get();
    if (!customer) throw new HTTPException(404, { message: "not_found" });
  }
}

/**
 * Inserts an order header row (shared by every order-creating path — staff
 * draft orders, POS, and the storefront checkout). Orders are header-only
 * side data (`architecture.md` §4.5): sale lines live on the linked draft
 * invoice, never on the order. The caller writes the transition event.
 */
export function insertOrderRecord(
  tx: Tx,
  input: { orderType: string; customerId: string | null; outletId: string; status: string },
): OrderRow {
  const now = Date.now();
  const orderNumber = freshDocNumber("OR", (n) =>
    Boolean(tx.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, n)).get()),
  );
  const row: OrderRow = {
    id: randomUUIDv7(),
    orderNumber,
    orderType: input.orderType,
    customerId: input.customerId,
    outletId: input.outletId,
    status: input.status,
    totalPaise: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  tx.insert(orders).values(row).run();
  return row;
}

export type CreateOrderInput = {
  orderType: "pos" | "manual";
  customerId?: string | null;
  outletId: string;
};

/**
 * Draft staff order (`api.md` §6) — header-only; sale lines enter through the
 * linked draft invoice that `confirmOrder` creates. Scoped to the order's own
 * outlet. Writes `order.created` (I8).
 */
export function createOrder(tx: Tx, actor: StaffActor, input: CreateOrderInput): OrderRow {
  requireCapability(actor, "canManageSales", input.outletId);
  assertOrderParties(tx, input.customerId ?? null, input.outletId);
  const row = insertOrderRecord(tx, {
    orderType: input.orderType,
    customerId: input.customerId ?? null,
    outletId: input.outletId,
    status: "draft",
  });
  writeOrderEvent(tx, row.id, "order.created", { status: "draft" }, actor.userId, "staff");
  return row;
}

export type UpdateOrderInput = {
  customerId?: string | null;
  outletId: string;
  version: number;
};

/**
 * Draft-only, versioned edit (race R5) of the header-only order. Scoped to the
 * draft's new outlet.
 */
export function updateOrder(tx: Tx, actor: StaffActor, orderId: string, input: UpdateOrderInput): OrderRow {
  requireCapability(actor, "canManageSales", input.outletId);
  const existing = tx.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  if (existing.status !== "draft") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  if (input.version !== existing.version) {
    throw new HTTPException(409, { message: "stale_version" });
  }
  assertOrderParties(tx, input.customerId ?? null, input.outletId);
  const now = Date.now();
  tx.update(orders)
    .set({ customerId: input.customerId ?? null, outletId: input.outletId, version: existing.version + 1, updatedAt: now })
    .where(and(eq(orders.id, orderId), eq(orders.version, input.version)))
    .run();
  return { ...existing, customerId: input.customerId ?? null, outletId: input.outletId, version: existing.version + 1, updatedAt: now };
}

function draftInvoiceOfOrder(tx: Tx, orderId: string): InvoiceRow | undefined {
  return tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.orderId, orderId), eq(invoices.status, "draft")))
    .orderBy(desc(invoices.createdAt), desc(invoices.id))
    .limit(1)
    .get();
}

/**
 * Validates a sale line set and resolves every line to its server-side money
 * snapshot (`architecture.md` §4.4 — the closed client-originable list): a
 * regular line's `unitPricePaise`/`taxRatePct` are re-derived from the current
 * variant (`sellingPricePaise`) and its product (`gstRatePct` when `isTaxable`)
 * — a client-sent price is stripped at the route boundary and never reaches
 * this function; a custom line carries its client-supplied `name`/`quantity`/
 * `unitPricePaise` (staff-only) at `taxRatePct = 0` (tax is not
 * client-originable). Duplicate regular `variantId` within the document → 400.
 */
export function resolveSaleLines(tx: Tx, items: SaleLineInput[]): ResolvedInvoiceLine[] {
  const seen = new Set<string>();
  return items.map((line) => {
    if ("variantId" in line) {
      if (seen.has(line.variantId)) {
        throw new HTTPException(400, { message: "duplicate line" });
      }
      seen.add(line.variantId);
      const row = tx
        .select({
          variantId: variants.id,
          name: variants.name,
          sellingPricePaise: variants.sellingPricePaise,
          isTaxable: variants.isTaxable,
          gstRatePct: products.gstRatePct,
        })
        .from(variants)
        .innerJoin(products, eq(products.id, variants.productId))
        .where(eq(variants.id, line.variantId))
        .get();
      if (!row) throw new HTTPException(404, { message: "not_found" });
      const taxRatePct = row.isTaxable === 1 ? row.gstRatePct : 0;
      return {
        variantId: line.variantId,
        name: row.name,
        quantity: line.quantity,
        unitPricePaise: row.sellingPricePaise,
        taxRatePct,
        taxAmountPaise: computeTaxAmountPaise(row.sellingPricePaise, line.quantity, taxRatePct),
        lineTotalPaise: computeLineTotalPaise(row.sellingPricePaise, line.quantity, taxRatePct),
        isCustomItem: 0,
        allocations: [],
      };
    }
    return {
      variantId: null,
      name: line.name,
      quantity: line.quantity,
      unitPricePaise: line.unitPricePaise,
      taxRatePct: 0,
      taxAmountPaise: 0,
      lineTotalPaise: line.unitPricePaise * line.quantity,
      isCustomItem: 1,
      allocations: [],
    };
  });
}

function assertCharges(charges: SaleChargeInput[]): void {
  for (const charge of charges) {
    if (charge.name.length === 0) {
      throw new HTTPException(400, { message: "charge name required" });
    }
  }
}

/**
 * Header totals are always derived from the line/charge snapshots, never
 * client-supplied (architecture.md §4.4, I4): `subtotal = Σ unitPrice×qty`,
 * `tax = Σ line tax`, `total = subtotal + tax + Σ signed charges`. `total ≥ 0`
 * is enforced at issue, not before — a draft may be transiently negative.
 */
function computeInvoiceTotals(
  lines: { unitPricePaise: number; quantity: number; taxAmountPaise: number }[],
  charges: { amountPaise: number }[],
): { subtotalPaise: number; taxPaise: number; totalPaise: number } {
  const subtotalPaise = lines.reduce((s, l) => s + l.unitPricePaise * l.quantity, 0);
  const taxPaise = lines.reduce((s, l) => s + l.taxAmountPaise, 0);
  const totalPaise = subtotalPaise + taxPaise + charges.reduce((s, c) => s + c.amountPaise, 0);
  return { subtotalPaise, taxPaise, totalPaise };
}

function insertInvoiceLines(tx: Tx, invoiceId: string, lines: ResolvedInvoiceLine[]): InvoiceItemRow[] {
  return lines.map((line) => {
    const row: InvoiceItemRow = {
      id: randomUUIDv7(),
      invoiceId,
      variantId: line.variantId,
      name: line.name,
      quantity: line.quantity,
      unitPricePaise: line.unitPricePaise,
      taxRatePct: line.taxRatePct,
      taxAmountPaise: line.taxAmountPaise,
      lineTotalPaise: line.lineTotalPaise,
      isCustomItem: line.isCustomItem,
      allocations: [],
    };
    tx.insert(invoiceItems).values(row).run();
    return row;
  });
}

function insertInvoiceCharges(tx: Tx, invoiceId: string, charges: SaleChargeInput[]): InvoiceChargeRow[] {
  return charges.map((charge) => {
    const row: InvoiceChargeRow = {
      id: randomUUIDv7(),
      invoiceId,
      name: charge.name,
      amountPaise: charge.amountPaise,
    };
    tx.insert(invoiceCharges).values(row).run();
    return row;
  });
}

/**
 * Creates the draft invoice linked to an order (used by `confirmOrder`, the
 * POS one-step checkout, and the storefront checkout). Lines are resolved and
 * money-computed here from the client-originable inputs; the header starts at
 * version 1 with totals derived from the lines just written.
 */
export function createInvoiceDraft(
  tx: Tx,
  input: { orderId: string; customerId: string | null; outletId: string; items: SaleLineInput[]; charges: SaleChargeInput[] },
): InvoiceWithLines {
  const charges = input.charges;
  assertCharges(charges);
  const lines = resolveSaleLines(tx, input.items);
  const now = Date.now();
  const invoiceNumber = freshDocNumber("INV", (n) =>
    Boolean(tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.invoiceNumber, n)).get()),
  );
  const row: InvoiceRow = {
    id: randomUUIDv7(),
    invoiceNumber,
    orderId: input.orderId,
    customerId: input.customerId,
    outletId: input.outletId,
    status: "draft",
    subtotalPaise: 0,
    taxPaise: 0,
    totalPaise: 0,
    pdfPath: null,
    supersedesId: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  tx.insert(invoices).values(row).run();
  const items = insertInvoiceLines(tx, row.id, lines);
  const chargeRows = insertInvoiceCharges(tx, row.id, charges);
  const totals = computeInvoiceTotals(items, chargeRows);
  tx.update(invoices)
    .set({ ...totals })
    .where(eq(invoices.id, row.id))
    .run();
  return { ...row, ...totals, items, charges: chargeRows };
}

/**
 * `draft → confirmed` (`architecture.md` §4.7): creates the linked draft
 * invoice when none exists (the order is header-only; lines enter via
 * `PUT /api/invoices/:id`), snapshots the order's `totalPaise` side data from
 * the invoice, and plays no stock. Re-confirm → `409 invalid_transition`.
 */
export function confirmOrder(tx: Tx, actor: StaffActor, orderId: string): OrderRow & { invoice: InvoiceRow } {
  const existing = tx.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManageSales", existing.outletId);
  if (existing.status !== "draft") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  const draft = draftInvoiceOfOrder(tx, orderId);
  const invoice: InvoiceWithLines = draft
    ? {
        ...draft,
        items: tx
          .select()
          .from(invoiceItems)
          .where(eq(invoiceItems.invoiceId, draft.id))
          .orderBy(asc(invoiceItems.id))
          .all(),
        charges: tx
          .select()
          .from(invoiceCharges)
          .where(eq(invoiceCharges.invoiceId, draft.id))
          .orderBy(asc(invoiceCharges.id))
          .all(),
      }
    : createInvoiceDraft(tx, { orderId, customerId: existing.customerId, outletId: existing.outletId, items: [], charges: [] });
  const now = Date.now();
  tx.update(orders)
    .set({ status: "confirmed", totalPaise: invoice.totalPaise, updatedAt: now })
    .where(eq(orders.id, orderId))
    .run();
  writeOrderEvent(tx, orderId, "order.confirmed", { status: "confirmed", invoiceId: invoice.id }, actor.userId, "staff");
  return { ...existing, status: "confirmed", totalPaise: invoice.totalPaise, updatedAt: now, invoice };
}

/**
 * Voids the order's linked draft invoice if one exists — used when an order is
 * cancelled while its draft invoice has lines (the invoice must not outlive
 * the order it belongs to).
 */
function voidLinkedDraftInvoice(tx: Tx, orderId: string): void {
  const invoice = draftInvoiceOfOrder(tx, orderId);
  if (!invoice) return;
  tx.update(invoices)
    .set({ status: "void", updatedAt: Date.now() })
    .where(eq(invoices.id, invoice.id))
    .run();
}

/**
 * Staff cancel (`api.md` §6): a `draft` or `pending` order → `cancelled`;
 * anything later is `409 invalid_transition`. A linked draft invoice (pending
 * storefront orders carry one) is voided in the same transaction.
 */
export function cancelOrder(tx: Tx, actor: StaffActor, orderId: string): OrderRow {
  const existing = tx.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManageSales", existing.outletId);
  if (existing.status !== "draft" && existing.status !== "pending") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  voidLinkedDraftInvoice(tx, orderId);
  const now = Date.now();
  tx.update(orders)
    .set({ status: "cancelled", updatedAt: now })
    .where(eq(orders.id, orderId))
    .run();
  writeOrderEvent(tx, orderId, "order.cancelled", { status: "cancelled" }, actor.userId, "staff");
  return { ...existing, status: "cancelled", updatedAt: now };
}

export type UpdateInvoiceInput = {
  items: SaleLineInput[];
  charges?: SaleChargeInput[];
  version: number;
};

/**
 * Draft-only, versioned, full-replace edit of an invoice's line/charge set
 * (race R5). Guarded `S` per `api.md` §6 (any staff session — draft invoice
 * editing is part of the POS quote flow), so no capability is asserted here.
 */
export function updateInvoice(tx: Tx, _actor: StaffActor, invoiceId: string, input: UpdateInvoiceInput): InvoiceWithLines {
  const existing = tx.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  if (existing.status !== "draft") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  if (input.version !== existing.version) {
    throw new HTTPException(409, { message: "stale_version" });
  }
  const charges = input.charges ?? [];
  assertCharges(charges);
  const lines = resolveSaleLines(tx, input.items);
  const now = Date.now();
  tx.update(invoices)
    .set({ version: existing.version + 1, updatedAt: now })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.version, input.version)))
    .run();
  tx.delete(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId)).run();
  tx.delete(invoiceCharges).where(eq(invoiceCharges.invoiceId, invoiceId)).run();
  const items = insertInvoiceLines(tx, invoiceId, lines);
  const chargeRows = insertInvoiceCharges(tx, invoiceId, charges);
  const totals = computeInvoiceTotals(items, chargeRows);
  tx.update(invoices)
    .set({ ...totals })
    .where(eq(invoices.id, invoiceId))
    .run();
  return { ...existing, ...totals, version: existing.version + 1, updatedAt: now, items, charges: chargeRows };
}

/**
 * The shared `issueInvoice` money/stock core (`architecture.md` §4.7),
 * behind POS checkout, staff issue, storefront COD, and (phase 8) the gateway
 * webhook path. One transaction, one-shot:
 *
 * - money is re-derived from the stored line snapshots (I4 — never the draft's
 *   stored totals, never a client-supplied total), `total ≥ 0` enforced;
 * - each regular line is FIFO-allocated across the outlet's batches by expiry
 *   (`allocateBatches` over `batchHoldings`, both in-transaction decision
 *   reads — §4.6); an unsatisfiable line throws `409 insufficient_stock` and
 *   rolls back the whole document, zero movements survive;
 * - one `sale` out-movement per allocation, `sourceType=sale`/`sourceId` =
 *   invoice id (fact rows before the header flip, T3); custom lines carry no
 *   stock and no allocation;
 * - the header is marked `issued` with the recomputed totals, and the order's
 *   timeline gets an `invoice.issued` row (I8). Re-issue → `409 already_issued`,
 *   zero rows.
 *
 * `issueInvoice` is the staff entry point (capability asserted); the customer
 * paths (COD checkout) and the gateway webhook (phase 8, actorType `webhook`,
 * actorId null) are the zero-capability cases by design and call
 * `issueInvoiceCore` directly — §4.14's capability enforcement lives in the
 * staff wrapper.
 */
export function issueInvoiceCore(
  tx: Tx,
  actor: { userId: string | null },
  invoiceId: string,
  actorType: "staff" | "customer" | "webhook" = "staff",
): InvoiceRow {
  const existing = tx.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  if (existing.status !== "draft") {
    throw new HTTPException(409, { message: existing.status === "void" ? "invalid_transition" : "already_issued" });
  }
  const lines = tx
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId))
    .orderBy(asc(invoiceItems.id))
    .all();
  const charges = tx
    .select()
    .from(invoiceCharges)
    .where(eq(invoiceCharges.invoiceId, invoiceId))
    .orderBy(asc(invoiceCharges.id))
    .all();
  const prepared: { line: InvoiceItemRow; allocations: InvoiceAllocation[] }[] = [];
  for (const line of lines) {
    const taxAmountPaise = computeTaxAmountPaise(line.unitPricePaise, line.quantity, line.taxRatePct);
    const lineTotalPaise = computeLineTotalPaise(line.unitPricePaise, line.quantity, line.taxRatePct);
    let allocations: InvoiceAllocation[] = [];
    if (line.isCustomItem === 0 && line.variantId) {
      const alloc = allocateBatches(batchHoldings(tx, line.variantId, existing.outletId), line.quantity);
      if (!alloc) {
        throw new HTTPException(409, { message: "insufficient_stock" });
      }
      allocations = alloc;
    }
    prepared.push({ line: { ...line, taxAmountPaise, lineTotalPaise }, allocations });
  }
  const totals = computeInvoiceTotals(
    prepared.map((p) => p.line),
    charges,
  );
  if (totals.totalPaise < 0) {
    throw new HTTPException(400, { message: "total must be non-negative" });
  }
  for (const { line, allocations } of prepared) {
    tx.update(invoiceItems)
      .set({ taxAmountPaise: line.taxAmountPaise, lineTotalPaise: line.lineTotalPaise, allocations })
      .where(eq(invoiceItems.id, line.id))
      .run();
    for (const allocation of allocations) {
      writeMovement(tx, {
        variantId: line.variantId!,
        outletId: existing.outletId,
        batchId: allocation.batchId,
        delta: -allocation.qty,
        reason: "sale",
        sourceType: "sale",
        sourceId: invoiceId,
      });
    }
  }
  if (existing.orderId) {
    writeOrderEvent(tx, existing.orderId, "invoice.issued", { status: "issued", invoiceId }, actor.userId, actorType);
  }
  const now = Date.now();
  tx.update(invoices)
    .set({ status: "issued", ...totals, updatedAt: now })
    .where(eq(invoices.id, invoiceId))
    .run();
  return { ...existing, status: "issued", ...totals, updatedAt: now };
}

export function issueInvoice(tx: Tx, actor: StaffActor, invoiceId: string): InvoiceRow {
  const existing = tx.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManageSales", existing.outletId);
  return issueInvoiceCore(tx, actor, invoiceId);
}

/**
 * `void` exists only on drafts (`architecture.md` §4.7) — a draft invoice has
 * no movements, so voiding never touches stock. An issued invoice is unwound
 * by sales returns + refund payments, never by voiding.
 */
export function voidInvoice(tx: Tx, actor: StaffActor, invoiceId: string): InvoiceRow {
  const existing = tx.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManageSales", existing.outletId);
  if (existing.status !== "draft") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  const now = Date.now();
  tx.update(invoices)
    .set({ status: "void", updatedAt: now })
    .where(eq(invoices.id, invoiceId))
    .run();
  return { ...existing, status: "void", updatedAt: now };
}

export type PosCheckoutInput = {
  customerId?: string | null;
  outletId: string;
  items: SaleLineInput[];
  charges?: SaleChargeInput[];
};

/**
 * POS one-step sale (`api.md` §6): create the `pos` order and its draft
 * invoice, confirm, and issue — all in one transaction, through the same
 * `issueInvoiceCore` every other path uses. Stock drops instantly; any gate
 * failure (insufficient stock, unknown variant) rolls back the entire
 * document, zero movements survive.
 */
export function posCheckout(tx: Tx, actor: StaffActor, input: PosCheckoutInput): { order: OrderRow; invoice: InvoiceRow } {
  requireCapability(actor, "canManageSales", input.outletId);
  assertOrderParties(tx, input.customerId ?? null, input.outletId);
  const order = insertOrderRecord(tx, {
    orderType: "pos",
    customerId: input.customerId ?? null,
    outletId: input.outletId,
    status: "draft",
  });
  writeOrderEvent(tx, order.id, "order.created", { status: "draft" }, actor.userId, "staff");
  const invoice = createInvoiceDraft(tx, {
    orderId: order.id,
    customerId: input.customerId ?? null,
    outletId: input.outletId,
    items: input.items,
    charges: input.charges ?? [],
  });
  const now = Date.now();
  tx.update(orders)
    .set({ status: "confirmed", totalPaise: invoice.totalPaise, updatedAt: now })
    .where(eq(orders.id, order.id))
    .run();
  writeOrderEvent(tx, order.id, "order.confirmed", { status: "confirmed", invoiceId: invoice.id }, actor.userId, "staff");
  const issued = issueInvoiceCore(tx, actor, invoice.id);
  return {
    order: { ...order, status: "confirmed", totalPaise: invoice.totalPaise, updatedAt: now },
    invoice: issued,
  };
}

export type OrderWithEvents = OrderRow & { events: (typeof orderEvents.$inferSelect)[] };

export function listOrders(opts: { page: number; pageSize: number }): { rows: OrderRow[]; total: number } {
  const total = db.select({ n: count() }).from(orders).get()?.n ?? 0;
  const rows = db
    .select()
    .from(orders)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize)
    .all();
  return { rows, total };
}

export function getOrder(orderId: string): OrderWithEvents | null {
  const header = db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!header) return null;
  const events = db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, orderId))
    .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id))
    .all();
  return { ...header, events };
}

export function listInvoices(opts: { page: number; pageSize: number }): { rows: InvoiceRow[]; total: number } {
  const total = db.select({ n: count() }).from(invoices).get()?.n ?? 0;
  const rows = db
    .select()
    .from(invoices)
    .orderBy(desc(invoices.createdAt), desc(invoices.id))
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize)
    .all();
  return { rows, total };
}

/**
 * Invoice detail (`api.md` §6) with the computed outstanding balance
 * (`architecture.md` §4.4): `totalPaise − (Σ in − Σ out)` over **confirmed**
 * `payments` rows linked to the invoice — the checkout's `pending` placeholder
 * row has moved zero money and is excluded. Return-linked refunds carry the
 * invoice id, so they reduce outstanding automatically. Recomputed on read,
 * never cached.
 */
export function getInvoice(invoiceId: string): (InvoiceWithLines & { outstandingPaise: number }) | null {
  const header = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!header) return null;
  const items = db
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId))
    .orderBy(asc(invoiceItems.id))
    .all();
  const charges = db
    .select()
    .from(invoiceCharges)
    .where(eq(invoiceCharges.invoiceId, invoiceId))
    .orderBy(asc(invoiceCharges.id))
    .all();
  const sums = db
    .select({ direction: payments.direction, total: payments.amountPaise })
    .from(payments)
    .where(and(eq(payments.invoiceId, invoiceId), eq(payments.status, "confirmed")))
    .all();
  const balance = sums.reduce((acc, p) => acc + (p.direction === "in" ? p.total : -p.total), 0);
  return { ...header, items, charges, outstandingPaise: header.totalPaise - balance };
}
