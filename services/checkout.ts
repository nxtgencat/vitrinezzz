import { randomUUIDv7 } from "bun";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { cartItems } from "../db/schema/cart";
import { custAddresses } from "../db/schema/catalog";
import { orderEvents } from "../db/schema/facts";
import { invoiceCharges, invoiceItems, invoices, orders } from "../db/schema/orders";
import { outlets, settings } from "../db/schema/org";
import { payments } from "../db/schema/payments";
import { db } from "../lib/db";
import type { Tx } from "../lib/db";
import { freshDocNumber } from "../lib/doc-number";
import type { CustomerActor } from "./rbac";
import {
  createInvoiceDraft,
  insertOrderRecord,
  issueInvoiceCore,
  resolveSaleLines,
  writeOrderEvent,
} from "./sales";
import type { InvoiceWithLines, SaleLineInput } from "./sales";
import { sumStock } from "./stock";

/**
 * The storefront's outlet (`api.md` §9, spec fix): `settings.defaultOutletId`
 * when set, else the first active outlet by creation order — deterministic,
 * never a random pick. No outlet at all is a misconfiguration, not a 404.
 */
export function resolveStorefrontOutlet(tx: Tx): { id: string } {
  const row = tx.select().from(settings).get();
  if (row?.defaultOutletId) {
    const outlet = tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(and(eq(outlets.id, row.defaultOutletId), eq(outlets.isActive, 1)))
      .get();
    if (outlet) return outlet;
  }
  const fallback = tx
    .select({ id: outlets.id })
    .from(outlets)
    .where(eq(outlets.isActive, 1))
    .orderBy(asc(outlets.createdAt), asc(outlets.id))
    .limit(1)
    .get();
  if (!fallback) {
    throw new HTTPException(500, { message: "no outlet configured" });
  }
  return fallback;
}

type CartLine = { variantId: string; quantity: number };

/** Cart rows re-joined in-transaction — checkout never trusts cached pricing. */
function loadCartLines(tx: Tx, customerId: string): CartLine[] {
  return tx
    .select({ variantId: cartItems.variantId, quantity: cartItems.quantity })
    .from(cartItems)
    .where(eq(cartItems.customerId, customerId))
    .orderBy(asc(cartItems.createdAt), asc(cartItems.id))
    .all();
}

export type StorefrontCheckoutInput = {
  custAddressId: string;
  paymentMode: "cod" | "gateway";
};

export type StorefrontCheckoutResult = {
  order: {
    id: string;
    orderNumber: string;
    status: string;
    totalPaise: number;
    createdAt: number;
  };
  invoice: InvoiceWithLines;
  payment: (typeof payments.$inferSelect) | null;
  checkoutReference: string | null;
};

/**
 * Storefront checkout (`architecture.md` §4.11, `api.md` §9). The caller's
 * session is the only identity — `customerId`, the address, and the cart are
 * resolved from it, never from the body (which is exactly
 * `{ custAddressId, paymentMode }`).
 *
 * COD — the order is created `pending`, then confirmed and its invoice issued
 * in the same transaction (payment is recorded at delivery, phase 8); the cart
 * is cleared only after issue succeeds, so a 409 rolls everything back and the
 * cart survives.
 *
 * Gateway — the order stays `pending` with a draft invoice and a `pending`
 * payment row (`mode=gateway`, insert-only by trigger); per-line stock is
 * pre-gated (`sumStock ≥ qty`) but not allocated, and the cart is kept — it
 * only clears on the webhook-confirmed payment (phase 8). The pending row
 * exists so reconciliation can always link a checkout attempt to an order.
 */
export function storefrontCheckout(tx: Tx, customer: CustomerActor, input: StorefrontCheckoutInput): StorefrontCheckoutResult {
  const outlet = resolveStorefrontOutlet(tx);
  const address = tx
    .select({ id: custAddresses.id })
    .from(custAddresses)
    .where(and(eq(custAddresses.id, input.custAddressId), eq(custAddresses.customerId, customer.customerId)))
    .get();
  if (!address) throw new HTTPException(404, { message: "not_found" });
  const lines = loadCartLines(tx, customer.customerId);
  if (lines.length === 0) {
    throw new HTTPException(400, { message: "cart is empty" });
  }
  const items: SaleLineInput[] = lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity }));

  if (input.paymentMode === "cod") {
    const order = insertOrderRecord(tx, {
      orderType: "storefront",
      customerId: customer.customerId,
      outletId: outlet.id,
      status: "pending",
    });
    writeOrderEvent(tx, order.id, "order.created", { status: "pending" }, customer.userId, "customer");
    const invoice = createInvoiceDraft(tx, {
      orderId: order.id,
      customerId: customer.customerId,
      outletId: outlet.id,
      items,
      charges: [],
    });
    tx.update(orders)
      .set({ status: "confirmed", totalPaise: invoice.totalPaise, updatedAt: Date.now() })
      .where(eq(orders.id, order.id))
      .run();
    writeOrderEvent(tx, order.id, "order.confirmed", { status: "confirmed", invoiceId: invoice.id }, customer.userId, "customer");
    const issued = issueInvoiceCore(tx, customer, invoice.id, "customer");
    tx.delete(cartItems).where(eq(cartItems.customerId, customer.customerId)).run();
    const issuedItems = tx
      .select()
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, issued.id))
      .orderBy(asc(invoiceItems.id))
      .all();
    const issuedCharges = tx.select().from(invoiceCharges).where(eq(invoiceCharges.invoiceId, issued.id)).all();
    return {
      order: { id: order.id, orderNumber: order.orderNumber, status: "confirmed", totalPaise: issued.totalPaise, createdAt: order.createdAt },
      invoice: { ...issued, items: issuedItems, charges: issuedCharges },
      payment: null,
      checkoutReference: null,
    };
  }

  for (const line of resolveSaleLines(tx, items)) {
    if (line.variantId && sumStock(tx, line.variantId, outlet.id) < line.quantity) {
      throw new HTTPException(409, { message: "insufficient_stock" });
    }
  }
  const order = insertOrderRecord(tx, {
    orderType: "storefront",
    customerId: customer.customerId,
    outletId: outlet.id,
    status: "pending",
  });
  writeOrderEvent(tx, order.id, "order.created", { status: "pending" }, customer.userId, "customer");
  const invoice = createInvoiceDraft(tx, {
    orderId: order.id,
    customerId: customer.customerId,
    outletId: outlet.id,
    items,
    charges: [],
  });
  const now = Date.now();
  const paymentNumber = freshDocNumber("PY", (n) =>
    Boolean(tx.select({ id: payments.id }).from(payments).where(eq(payments.paymentNumber, n)).get()),
  );
  const checkoutReference = randomUUIDv7();
  const payment = {
    id: randomUUIDv7(),
    paymentNumber,
    direction: "in" as const,
    partyType: "customer" as const,
    partyId: customer.customerId,
    invoiceId: invoice.id,
    purchaseBillId: null,
    returnId: null,
    outletId: outlet.id,
    amountPaise: invoice.totalPaise,
    mode: "gateway" as const,
    gateway: null,
    gatewayPaymentId: checkoutReference,
    gatewayEventId: null,
    status: "pending" as const,
    createdAt: now,
  };
  tx.insert(payments).values(payment).run();
  return {
    order: { id: order.id, orderNumber: order.orderNumber, status: "pending", totalPaise: invoice.totalPaise, createdAt: order.createdAt },
    invoice,
    payment,
    checkoutReference,
  };
}

export type CustomerOrderWithItems = {
  id: string;
  orderNumber: string;
  orderType: string;
  status: string;
  totalPaise: number;
  createdAt: number;
  invoice: {
    id: string;
    invoiceNumber: string;
    status: string;
    subtotalPaise: number;
    taxPaise: number;
    totalPaise: number;
  } | null;
};

/** Own orders only — any other order is indistinguishable from a missing row. */
export function listCustomerOrders(customerId: string): CustomerOrderWithItems[] {
  const rows = db
    .select()
    .from(orders)
    .where(eq(orders.customerId, customerId))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .all();
  const orderIds = rows.map((r) => r.id);
  const invoiceRows = orderIds.length > 0 ? db.select().from(invoices).where(inArray(invoices.orderId, orderIds)).all() : [];
  const invoiceByOrder = new Map(invoiceRows.map((invoice) => [invoice.orderId, invoice]));
  return rows.map((row) => {
    const invoice = invoiceByOrder.get(row.id) ?? null;
    return {
      id: row.id,
      orderNumber: row.orderNumber,
      orderType: row.orderType,
      status: row.status,
      totalPaise: row.totalPaise,
      createdAt: row.createdAt,
      invoice: invoice
        ? {
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            status: invoice.status,
            subtotalPaise: invoice.subtotalPaise,
            taxPaise: invoice.taxPaise,
            totalPaise: invoice.totalPaise,
          }
        : null,
    };
  });
}

export type CustomerOrderDetail = CustomerOrderWithItems & {
  events: (typeof orderEvents.$inferSelect)[];
  items: (typeof invoiceItems.$inferSelect)[];
};

export function getCustomerOrder(customerId: string, orderId: string): CustomerOrderDetail | null {
  const row = db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)))
    .get();
  if (!row) return null;
  const events = db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, orderId))
    .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id))
    .all();
  const invoice = db
    .select()
    .from(invoices)
    .where(eq(invoices.orderId, orderId))
    .orderBy(desc(invoices.createdAt), desc(invoices.id))
    .limit(1)
    .get();
  const items = invoice
    ? db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoice.id)).orderBy(asc(invoiceItems.id)).all()
    : [];
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    orderType: row.orderType,
    status: row.status,
    totalPaise: row.totalPaise,
    createdAt: row.createdAt,
    invoice: invoice
      ? {
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          subtotalPaise: invoice.subtotalPaise,
          taxPaise: invoice.taxPaise,
          totalPaise: invoice.totalPaise,
        }
      : null,
    events,
    items,
  };
}

/**
 * Customer cancel (`api.md` §9): a `pending` gateway order → `cancelled`; its
 * draft invoice is voided and its pending payment row stays as permanent
 * history (the payments table is insert-only by trigger, I1). Everything later
 * is `409 invalid_transition`.
 */
export function cancelCustomerOrder(tx: Tx, customer: CustomerActor, orderId: string): { id: string; status: string } {
  const row = tx
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customer.customerId)))
    .get();
  if (!row) throw new HTTPException(404, { message: "not_found" });
  if (row.status !== "pending") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  const invoice = tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.orderId, orderId), eq(invoices.status, "draft")))
    .get();
  if (invoice) {
    tx.update(invoices).set({ status: "void", updatedAt: Date.now() }).where(eq(invoices.id, invoice.id)).run();
  }
  tx.update(orders).set({ status: "cancelled", updatedAt: Date.now() }).where(eq(orders.id, orderId)).run();
  writeOrderEvent(tx, orderId, "order.cancelled", { status: "cancelled" }, customer.userId, "customer");
  return { id: orderId, status: "cancelled" };
}
