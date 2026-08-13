import { randomUUIDv7 } from "bun";
import { SQLiteError } from "bun:sqlite";
import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { customers, vendors } from "../db/schema/catalog";
import { cartItems } from "../db/schema/cart";
import { invoices, orders, returnItems, returns } from "../db/schema/orders";
import { payments } from "../db/schema/payments";
import { purchaseBills } from "../db/schema/purchasing";
import { db } from "../lib/db";
import type { Tx } from "../lib/db";
import { freshDocNumber } from "../lib/doc-number";
import { requireCapability } from "./rbac";
import type { StaffActor } from "./rbac";
import { issueInvoiceCore, writeOrderEvent } from "./sales";

type PaymentRow = typeof payments.$inferSelect;
type InvoiceRow = typeof invoices.$inferSelect;
type BillRow = typeof purchaseBills.$inferSelect;
type ReturnRow = typeof returns.$inferSelect;

export type RecordPaymentInput = {
  direction: "in" | "out";
  partyType: "customer" | "vendor";
  partyId: string;
  invoiceId?: string | null;
  purchaseBillId?: string | null;
  returnId?: string | null;
  amountPaise: number;
  mode: string;
  outletId: string;
};

/**
 * Balance/cap math (`architecture.md` §4.4, R3), one definition used by every
 * payment context. All sums are re-derived in-transaction from `payments`
 * fact rows — never cached, never client-supplied — and count **confirmed**
 * rows only: the storefront checkout's `pending` placeholder row (phase 7,
 * insert-only, never deleted) has moved zero money and must not inflate a
 * balance or cap.
 *
 * Return-linked refunds carry the document's id (recordPayment stamps it from
 * the return's own document), so they sit inside the direction sums — two
 * refund paths can never jointly exceed what was actually paid/collected.
 */
function invoicePaidBalance(tx: Tx, invoiceId: string): number {
  const inSum = tx
    .select({ total: sql<number>`coalesce(sum(${payments.amountPaise}), 0)` })
    .from(payments)
    .where(and(eq(payments.direction, "in"), eq(payments.invoiceId, invoiceId), eq(payments.status, "confirmed")))
    .get();
  const outSum = tx
    .select({ total: sql<number>`coalesce(sum(${payments.amountPaise}), 0)` })
    .from(payments)
    .where(and(eq(payments.direction, "out"), eq(payments.invoiceId, invoiceId), eq(payments.status, "confirmed")))
    .get();
  return (inSum?.total ?? 0) - (outSum?.total ?? 0);
}

function billPaidBalance(tx: Tx, billId: string): number {
  const outSum = tx
    .select({ total: sql<number>`coalesce(sum(${payments.amountPaise}), 0)` })
    .from(payments)
    .where(and(eq(payments.direction, "out"), eq(payments.purchaseBillId, billId), eq(payments.status, "confirmed")))
    .get();
  const inSum = tx
    .select({ total: sql<number>`coalesce(sum(${payments.amountPaise}), 0)` })
    .from(payments)
    .where(and(eq(payments.direction, "in"), eq(payments.purchaseBillId, billId), eq(payments.status, "confirmed")))
    .get();
  return (outSum?.total ?? 0) - (inSum?.total ?? 0);
}

/** The value of a confirmed return: Σ (unitPrice × qty + tax) over its lines. */
function confirmedReturnValue(tx: Tx, returnId: string): number {
  const rows = tx
    .select({ unitPricePaise: returnItems.unitPricePaise, quantity: returnItems.quantity, taxAmountPaise: returnItems.taxAmountPaise })
    .from(returnItems)
    .where(eq(returnItems.returnId, returnId))
    .all();
  return rows.reduce((s, r) => s + r.unitPricePaise * r.quantity + r.taxAmountPaise, 0);
}

/** Remaining refundable value of a confirmed return: its value minus refunds
 * already recorded against it (returnId-linked rows, insert-only, confirmed
 * only). */
function remainingReturnRefundable(tx: Tx, returnId: string): number {
  const already = tx
    .select({ total: sql<number>`coalesce(sum(${payments.amountPaise}), 0)` })
    .from(payments)
    .where(and(eq(payments.returnId, returnId), eq(payments.status, "confirmed")))
    .get();
  return confirmedReturnValue(tx, returnId) - (already?.total ?? 0);
}

function assertNotOver(cap: number, amountPaise: number): void {
  if (amountPaise > cap) {
    throw new HTTPException(409, { message: "over_payment" });
  }
}

function insertPaymentRow(
  tx: Tx,
  row: Omit<PaymentRow, "id" | "paymentNumber" | "createdAt" | "gateway" | "gatewayPaymentId" | "gatewayEventId" | "purchaseBillId" | "returnId"> & {
    paymentNumber?: string;
    gateway?: string | null;
    gatewayPaymentId?: string | null;
    gatewayEventId?: string | null;
    purchaseBillId?: string | null;
    returnId?: string | null;
  },
): PaymentRow {
  const now = Date.now();
  const paymentNumber =
    row.paymentNumber ??
    freshDocNumber("PY", (n) =>
      Boolean(tx.select({ id: payments.id }).from(payments).where(eq(payments.paymentNumber, n)).get()),
    );
  const full: PaymentRow = {
    id: randomUUIDv7(),
    paymentNumber,
    direction: row.direction,
    partyType: row.partyType,
    partyId: row.partyId,
    invoiceId: row.invoiceId ?? null,
    purchaseBillId: row.purchaseBillId ?? null,
    returnId: row.returnId ?? null,
    outletId: row.outletId,
    amountPaise: row.amountPaise,
    mode: row.mode,
    gateway: row.gateway ?? null,
    gatewayPaymentId: row.gatewayPaymentId ?? null,
    gatewayEventId: row.gatewayEventId ?? null,
    status: row.status,
    createdAt: now,
  };
  tx.insert(payments).values(full).run();
  return full;
}

/**
 * The one staff payment write path (`api.md` §7) — one shape covering every
 * context, in/out, across cash/UPI/card/bank (gateway arrives via the webhook,
 * never this route):
 *
 * - `in` + customer + invoice — received; cap = invoice outstanding (R3).
 * - `out` + customer + invoice — refund; cap = invoice paid balance.
 * - `out` + vendor + bill — made; cap = bill outstanding.
 * - `in` + vendor + bill — vendor refund; cap = bill paid balance.
 * - `out` + customer + return (sales) — sales-return refund; cap = min(invoice
 *   paid balance, remaining return value).
 * - `in` + vendor + return (purchase) — purchase-return refund; cap =
 *   min(bill paid balance, remaining return value).
 *
 * Every cap violation is `409 over_payment` — one reason for one mechanism
 * (api.md §7 spec fix). The linked document must be `issued`/confirmed and the
 * party must be the document's own; the payment's outlet is the document's
 * outlet (a mismatching `outletId` in the body is a client bug, 400). Money
 * and balances are re-derived in-tx; no partial row survives a rejection.
 * `payments` is a [FACT] table — insert-only, trigger-protected, and it does
 * not write `audit_events` (architecture.md §4.12).
 */
export function recordPayment(tx: Tx, actor: StaffActor, input: RecordPaymentInput): PaymentRow {
  requireCapability(actor, "canManagePayments");
  const links = [input.invoiceId, input.purchaseBillId, input.returnId].filter((l) => l != null && l !== "");
  if (links.length !== 1) {
    throw new HTTPException(400, { message: "exactly one document link required" });
  }
  if (input.mode === "gateway") {
    throw new HTTPException(400, { message: "unsupported payment context" });
  }

  let partyId: string;
  let outletId: string;
  let rowInvoiceId: string | null = null;
  let rowBillId: string | null = null;

  if (input.purchaseBillId) {
    if (input.partyType !== "vendor") {
      throw new HTTPException(400, { message: "unsupported payment context" });
    }
    const bill: BillRow | undefined = tx.select().from(purchaseBills).where(eq(purchaseBills.id, input.purchaseBillId)).get();
    if (!bill) throw new HTTPException(404, { message: "not_found" });
    const vendor = tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, input.partyId)).get();
    if (!vendor) throw new HTTPException(404, { message: "not_found" });
    if (input.partyId !== bill.vendorId) {
      throw new HTTPException(400, { message: "party mismatch" });
    }
    if (bill.status !== "issued") {
      throw new HTTPException(409, { message: "invalid_transition" });
    }
    requireCapability(actor, "canManagePayments", bill.outletId);
    if (input.outletId !== bill.outletId) {
      throw new HTTPException(400, { message: "outlet mismatch" });
    }
    partyId = bill.vendorId;
    outletId = bill.outletId;
    rowBillId = bill.id;
    const cap = input.direction === "out" ? bill.totalPaise - billPaidBalance(tx, bill.id) : billPaidBalance(tx, bill.id);
    assertNotOver(cap, input.amountPaise);
  } else if (input.invoiceId) {
    if (input.partyType !== "customer") {
      throw new HTTPException(400, { message: "unsupported payment context" });
    }
    const invoice: InvoiceRow | undefined = tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).get();
    if (!invoice) throw new HTTPException(404, { message: "not_found" });
    const customer = tx.select({ id: customers.id }).from(customers).where(eq(customers.id, input.partyId)).get();
    if (!customer) throw new HTTPException(404, { message: "not_found" });
    if (!invoice.customerId || input.partyId !== invoice.customerId) {
      throw new HTTPException(400, { message: "party mismatch" });
    }
    if (invoice.status !== "issued") {
      throw new HTTPException(409, { message: "invalid_transition" });
    }
    requireCapability(actor, "canManagePayments", invoice.outletId);
    if (input.outletId !== invoice.outletId) {
      throw new HTTPException(400, { message: "outlet mismatch" });
    }
    partyId = invoice.customerId;
    outletId = invoice.outletId;
    rowInvoiceId = invoice.id;
    const paid = invoicePaidBalance(tx, invoice.id);
    const cap = input.direction === "in" ? invoice.totalPaise - paid : paid;
    assertNotOver(cap, input.amountPaise);
  } else {
    const ret: ReturnRow | undefined = tx.select().from(returns).where(eq(returns.id, input.returnId!)).get();
    if (!ret) throw new HTTPException(404, { message: "not_found" });
    if (ret.status !== "confirmed") {
      throw new HTTPException(409, { message: "invalid_transition" });
    }
    if (ret.returnType === "sales") {
      if (input.direction !== "out" || input.partyType !== "customer") {
        throw new HTTPException(400, { message: "unsupported payment context" });
      }
      const order = tx.select().from(orders).where(eq(orders.id, ret.orderId!)).get();
      if (!order) throw new HTTPException(404, { message: "not_found" });
      const invoice = tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.orderId, order.id), eq(invoices.status, "issued")))
        .get();
      if (!invoice) throw new HTTPException(404, { message: "not_found" });
      const customer = tx.select({ id: customers.id }).from(customers).where(eq(customers.id, input.partyId)).get();
      if (!customer) throw new HTTPException(404, { message: "not_found" });
      if (!order.customerId || input.partyId !== order.customerId) {
        throw new HTTPException(400, { message: "party mismatch" });
      }
      requireCapability(actor, "canManagePayments", ret.outletId);
      if (input.outletId !== ret.outletId) {
        throw new HTTPException(400, { message: "outlet mismatch" });
      }
      partyId = order.customerId;
      outletId = ret.outletId;
      rowInvoiceId = invoice.id;
      const cap = Math.min(invoicePaidBalance(tx, invoice.id), remainingReturnRefundable(tx, ret.id));
      assertNotOver(cap, input.amountPaise);
    } else {
      if (input.direction !== "in" || input.partyType !== "vendor") {
        throw new HTTPException(400, { message: "unsupported payment context" });
      }
      const bill = tx.select().from(purchaseBills).where(eq(purchaseBills.id, ret.purchaseBillId!)).get();
      if (!bill) throw new HTTPException(404, { message: "not_found" });
      const vendor = tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, input.partyId)).get();
      if (!vendor) throw new HTTPException(404, { message: "not_found" });
      if (input.partyId !== bill.vendorId) {
        throw new HTTPException(400, { message: "party mismatch" });
      }
      requireCapability(actor, "canManagePayments", ret.outletId);
      if (input.outletId !== ret.outletId) {
        throw new HTTPException(400, { message: "outlet mismatch" });
      }
      partyId = bill.vendorId;
      outletId = ret.outletId;
      rowBillId = bill.id;
      const cap = Math.min(billPaidBalance(tx, bill.id), remainingReturnRefundable(tx, ret.id));
      assertNotOver(cap, input.amountPaise);
    }
  }

  return insertPaymentRow(tx, {
    direction: input.direction,
    partyType: input.partyType,
    partyId,
    invoiceId: rowInvoiceId ?? input.invoiceId ?? null,
    purchaseBillId: rowBillId ?? input.purchaseBillId ?? null,
    returnId: input.returnId ?? null,
    outletId,
    amountPaise: input.amountPaise,
    mode: input.mode,
    status: "confirmed",
  });
}

export type GatewayPaymentInput = {
  gateway: string;
  gatewayPaymentId: string;
  gatewayEventId: string;
};

export type GatewayPaymentResult = {
  status: "confirmed" | "refunded" | "replayed";
  paymentId?: string;
  refundPaymentId?: string;
  orderId?: string;
  invoiceId?: string;
};

/**
 * The gateway webhook's payment-confirm routine (`api.md` §7, `architecture.md`
 * §4.2/§4.7) — the zero-capability case by design, gated by the route's
 * signature verification, deduped on `UNIQUE(gateway, gatewayEventId)` (R7):
 *
 * 1. An already-confirmed `(gateway, gatewayEventId)` → `{ status: "replayed" }`
 *    with zero side effects (pre-check + UNIQUE backstop; a racing duplicate
 *    hits the constraint inside the tx and is caught the same way).
 * 2. The pending checkout row (phase 7, insert-only) is located by its
 *    `gatewayPaymentId` (= the checkout reference); missing → 404. The
 *    confirmed row's money is **derived from the pending row** — the gateway's
 *    amount is never trusted.
 * 3. `payment.confirmed` event, then the pending order's confirm+issue path:
 *    the final stock gate re-runs in-tx. On a late shortfall the order
 *    auto-cancels, the draft invoice voids, and the payment auto-refunds with
 *    an `out` row — an explicit compensation path, recorded in `order_events`.
 * 4. An order the customer already cancelled is the same compensation: the
 *    payment fact is never lost, and the money returns via a full refund.
 * 5. The customer's cart is cleared only when the confirm+issue path succeeds.
 */
export function confirmGatewayPayment(tx: Tx, input: GatewayPaymentInput): GatewayPaymentResult {
  const dedupe = tx
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.gateway, input.gateway), eq(payments.gatewayEventId, input.gatewayEventId), eq(payments.status, "confirmed")))
    .get();
  if (dedupe) return { status: "replayed" };

  const pending = tx
    .select()
    .from(payments)
    .where(and(eq(payments.gatewayPaymentId, input.gatewayPaymentId), eq(payments.mode, "gateway"), eq(payments.status, "pending")))
    .get();
  if (!pending) throw new HTTPException(404, { message: "not_found" });
  if (!pending.invoiceId) throw new HTTPException(404, { message: "not_found" });

  const confirmed = insertPaymentRow(tx, {
    direction: "in",
    partyType: "customer",
    partyId: pending.partyId,
    invoiceId: pending.invoiceId,
    outletId: pending.outletId,
    amountPaise: pending.amountPaise,
    mode: "gateway",
    gateway: input.gateway,
    gatewayPaymentId: pending.gatewayPaymentId,
    gatewayEventId: input.gatewayEventId,
    status: "confirmed",
  });

  const invoice = tx.select().from(invoices).where(eq(invoices.id, pending.invoiceId)).get();
  if (!invoice) throw new HTTPException(404, { message: "not_found" });
  const order = invoice.orderId ? tx.select().from(orders).where(eq(orders.id, invoice.orderId)).get() : undefined;
  if (!order) throw new HTTPException(404, { message: "not_found" });

  writeOrderEvent(tx, order.id, "payment.confirmed", { status: "confirmed", paymentId: confirmed.id, amountPaise: confirmed.amountPaise }, null, "webhook");

  const refund = (): PaymentRow =>
    insertPaymentRow(tx, {
      direction: "out",
      partyType: "customer",
      partyId: pending.partyId,
      invoiceId: invoice.id,
      outletId: invoice.outletId,
      amountPaise: confirmed.amountPaise,
      mode: "gateway",
      gateway: input.gateway,
      gatewayPaymentId: pending.gatewayPaymentId,
      status: "confirmed",
    });

  if (order.status === "cancelled") {
    const refundRow = refund();
    writeOrderEvent(tx, order.id, "payment.refunded", { paymentId: refundRow.id, amountPaise: refundRow.amountPaise }, null, "webhook");
    return { status: "refunded", paymentId: confirmed.id, refundPaymentId: refundRow.id, orderId: order.id, invoiceId: invoice.id };
  }
  if (order.status !== "pending") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }

  try {
    const now = Date.now();
    tx.update(orders)
      .set({ status: "confirmed", totalPaise: invoice.totalPaise, updatedAt: now })
      .where(eq(orders.id, order.id))
      .run();
    writeOrderEvent(tx, order.id, "order.confirmed", { status: "confirmed", invoiceId: invoice.id }, null, "webhook");
    issueInvoiceCore(tx, { userId: null }, invoice.id, "webhook");
    tx.delete(cartItems).where(eq(cartItems.customerId, pending.partyId)).run();
    return { status: "confirmed", paymentId: confirmed.id, orderId: order.id, invoiceId: invoice.id };
  } catch (err) {
    if (err instanceof SQLiteError && err.message.includes("payments.gateway")) {
      return { status: "replayed" };
    }
    if (err instanceof HTTPException && err.status === 409 && err.message === "insufficient_stock") {
      const now = Date.now();
      tx.update(orders).set({ status: "cancelled", updatedAt: now }).where(eq(orders.id, order.id)).run();
      tx.update(invoices).set({ status: "void", updatedAt: now }).where(eq(invoices.id, invoice.id)).run();
      writeOrderEvent(tx, order.id, "order.cancelled", { status: "cancelled", reason: "insufficient_stock" }, null, "webhook");
      const refundRow = refund();
      writeOrderEvent(tx, order.id, "payment.refunded", { paymentId: refundRow.id, amountPaise: refundRow.amountPaise }, null, "webhook");
      return { status: "refunded", paymentId: confirmed.id, refundPaymentId: refundRow.id, orderId: order.id, invoiceId: invoice.id };
    }
    throw err;
  }
}

export type PaymentListOptions = {
  direction?: string;
  partyType?: string;
  partyId?: string;
  from?: number;
  to?: number;
  page: number;
  pageSize: number;
};

export function listPayments(opts: PaymentListOptions): { rows: PaymentRow[]; total: number } {
  const conditions = [];
  if (opts.direction) conditions.push(eq(payments.direction, opts.direction));
  if (opts.partyType) conditions.push(eq(payments.partyType, opts.partyType));
  if (opts.partyId) conditions.push(eq(payments.partyId, opts.partyId));
  if (opts.from !== undefined) conditions.push(gte(payments.createdAt, opts.from));
  if (opts.to !== undefined) conditions.push(lte(payments.createdAt, opts.to));
  const where = and(...conditions);
  const total = db.select({ n: count() }).from(payments).where(where).get()?.n ?? 0;
  const rows = db
    .select()
    .from(payments)
    .where(where)
    .orderBy(desc(payments.createdAt), desc(payments.id))
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize)
    .all();
  return { rows, total };
}