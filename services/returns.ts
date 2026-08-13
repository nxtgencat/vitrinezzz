import { randomUUIDv7 } from "bun";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { invoices, invoiceItems, orders, returnItems, returns } from "../db/schema/orders";
import type { Tx } from "../lib/db";
import { freshDocNumber } from "../lib/doc-number";
import type { CustomerActor } from "./rbac";

type ReturnRow = typeof returns.$inferSelect;
type ReturnItemRow = typeof returnItems.$inferSelect;

export type SalesReturnItemInput = {
  originalItemId: string;
  quantity: number;
};

/**
 * Draft customer sales return (`api.md` §9, `schema.md` §7). Only a `confirmed`
 * order of the session customer with an `issued` invoice can be returned
 * against; each line must reference an `invoice_items` row of that invoice and
 * request 1..original quantity. Custom lines (`variantId IS NULL`) cannot be
 * returned — `return_items.variantId` is NOT NULL by schema.
 *
 * Money is copied from the original line at create (unit price and the tax
 * amount charged); the confirm step (phase 8) re-snapshots from the invoice
 * and enforces the per-invoice caps. Draft creation plays no stock and emits
 * no fact rows or events (I11).
 */
export function createSalesReturn(
  tx: Tx,
  customer: CustomerActor,
  input: { orderId: string; items: SalesReturnItemInput[] },
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
  const invoice = tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.orderId, order.id), eq(invoices.status, "issued")))
    .get();
  if (!invoice) throw new HTTPException(404, { message: "not_found" });

  const seen = new Set<string>();
  const rows: ReturnItemRow[] = input.items.map((item) => {
    if (seen.has(item.originalItemId)) {
      throw new HTTPException(400, { message: "duplicate line" });
    }
    seen.add(item.originalItemId);
    const original = tx
      .select()
      .from(invoiceItems)
      .where(and(eq(invoiceItems.id, item.originalItemId), eq(invoiceItems.invoiceId, invoice.id)))
      .get();
    if (!original) throw new HTTPException(404, { message: "not_found" });
    if (original.variantId === null || original.isCustomItem === 1) {
      throw new HTTPException(400, { message: "custom line returns not supported" });
    }
    if (item.quantity < 1 || item.quantity > original.quantity) {
      throw new HTTPException(400, { message: "quantity out of range" });
    }
    const row: ReturnItemRow = {
      id: randomUUIDv7(),
      returnId: "",
      variantId: original.variantId,
      originalItemId: original.id,
      quantity: item.quantity,
      unitPricePaise: original.unitPricePaise,
      taxAmountPaise: original.taxAmountPaise,
    };
    return row;
  });

  const now = Date.now();
  const returnNumber = freshDocNumber("RT", (n) =>
    Boolean(tx.select({ id: returns.id }).from(returns).where(eq(returns.returnNumber, n)).get()),
  );
  const header: ReturnRow = {
    id: randomUUIDv7(),
    returnNumber,
    returnType: "sales",
    orderId: order.id,
    purchaseBillId: null,
    outletId: order.outletId,
    status: "draft",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  tx.insert(returns).values(header).run();
  const saved: ReturnItemRow[] = rows.map((row) => {
    const full = { ...row, returnId: header.id };
    tx.insert(returnItems).values(full).run();
    return full;
  });
  return { returns: header, items: saved };
}