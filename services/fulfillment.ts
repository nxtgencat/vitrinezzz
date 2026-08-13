import { randomUUIDv7 } from "bun";
import { and, count, desc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { invoices, shipments } from "../db/schema/orders";
import { db } from "../lib/db";
import type { Tx } from "../lib/db";
import { freshDocNumber } from "../lib/doc-number";
import { requireCapability } from "./rbac";
import type { StaffActor } from "./rbac";
import { writeOrderEvent } from "./sales";

type ShipmentRow = typeof shipments.$inferSelect;

function shipmentWithInvoice(tx: Tx, shipmentId: string): ShipmentRow | undefined {
  const row = tx.select().from(shipments).where(eq(shipments.id, shipmentId)).get();
  return row;
}

function requireIssuedInvoice(tx: Tx, invoiceId: string): typeof invoices.$inferSelect {
  const invoice = tx.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!invoice) throw new HTTPException(404, { message: "not_found" });
  return invoice;
}

/**
 * Shipment creation (`api.md` §8, `architecture.md` §4.7): whole-invoice, no
 * line quantities; the invoice must be `issued` (else `409 invalid_transition`).
 * Outlet scope is the invoice's own outlet (shipments carry no outlet column —
 * the invoice's is the money/stock outlet). One invoice may have many
 * shipments; shipment state never changes invoice/order state.
 */
export function createShipment(
  tx: Tx,
  actor: StaffActor,
  input: { invoiceId: string; carrier: string; awbNumber?: string | null },
): ShipmentRow {
  const invoice = requireIssuedInvoice(tx, input.invoiceId);
  requireCapability(actor, "canManageFulfillment", invoice.outletId);
  if (input.carrier.length === 0) {
    throw new HTTPException(400, { message: "carrier required" });
  }
  const now = Date.now();
  const shipmentNumber = freshDocNumber("SH", (n) =>
    Boolean(tx.select({ id: shipments.id }).from(shipments).where(eq(shipments.shipmentNumber, n)).get()),
  );
  const row: ShipmentRow = {
    id: randomUUIDv7(),
    shipmentNumber,
    invoiceId: input.invoiceId,
    carrier: input.carrier,
    awbNumber: input.awbNumber ?? null,
    status: "created",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  tx.insert(shipments).values(row).run();
  return row;
}

export type UpdateShipmentInput = {
  carrier: string;
  awbNumber?: string | null;
  version: number;
};

/** Carrier/AWB edit, while `created` only, versioned (R5). */
export function updateShipment(tx: Tx, actor: StaffActor, shipmentId: string, input: UpdateShipmentInput): ShipmentRow {
  const existing = shipmentWithInvoice(tx, shipmentId);
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  const invoice = requireIssuedInvoice(tx, existing.invoiceId);
  requireCapability(actor, "canManageFulfillment", invoice.outletId);
  if (existing.status !== "created") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  if (input.version !== existing.version) {
    throw new HTTPException(409, { message: "stale_version" });
  }
  if (input.carrier.length === 0) {
    throw new HTTPException(400, { message: "carrier required" });
  }
  const now = Date.now();
  tx.update(shipments)
    .set({ carrier: input.carrier, awbNumber: input.awbNumber ?? null, version: existing.version + 1, updatedAt: now })
    .where(and(eq(shipments.id, shipmentId), eq(shipments.version, input.version)))
    .run();
  return { ...existing, carrier: input.carrier, awbNumber: input.awbNumber ?? null, version: existing.version + 1, updatedAt: now };
}

function transition(tx: Tx, actor: StaffActor, shipmentId: string, from: string, to: string, eventType: string): ShipmentRow {
  const existing = shipmentWithInvoice(tx, shipmentId);
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  const invoice = requireIssuedInvoice(tx, existing.invoiceId);
  requireCapability(actor, "canManageFulfillment", invoice.outletId);
  if (existing.status !== from) {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  const now = Date.now();
  tx.update(shipments)
    .set({ status: to, updatedAt: now })
    .where(eq(shipments.id, shipmentId))
    .run();
  if (invoice.orderId) {
    writeOrderEvent(tx, invoice.orderId, eventType, { status: to, shipmentId }, actor.userId, "staff");
  }
  return { ...existing, status: to, updatedAt: now };
}

/** `created → dispatched` (`api.md` §8). */
export function dispatchShipment(tx: Tx, actor: StaffActor, shipmentId: string): ShipmentRow {
  return transition(tx, actor, shipmentId, "created", "dispatched", "shipment.dispatched");
}

/** `dispatched → delivered`. */
export function deliverShipment(tx: Tx, actor: StaffActor, shipmentId: string): ShipmentRow {
  return transition(tx, actor, shipmentId, "dispatched", "delivered", "shipment.delivered");
}

export type ShipmentListOptions = {
  status?: string;
  page: number;
  pageSize: number;
};

export function listShipments(opts: ShipmentListOptions): { rows: ShipmentRow[]; total: number } {
  const where = opts.status ? eq(shipments.status, opts.status) : undefined;
  const total = db.select({ n: count() }).from(shipments).where(where).get()?.n ?? 0;
  const rows = db
    .select()
    .from(shipments)
    .where(where)
    .orderBy(desc(shipments.createdAt), desc(shipments.id))
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize)
    .all();
  return { rows, total };
}

export function getShipment(shipmentId: string): (ShipmentRow & { invoiceNumber: string | null }) | null {
  const header = db.select().from(shipments).where(eq(shipments.id, shipmentId)).get();
  if (!header) return null;
  const invoice = db.select({ invoiceNumber: invoices.invoiceNumber }).from(invoices).where(eq(invoices.id, header.invoiceId)).get();
  return { ...header, invoiceNumber: invoice?.invoiceNumber ?? null };
}