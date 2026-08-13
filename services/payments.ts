import { randomUUIDv7 } from "bun";
import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { vendors } from "../db/schema/catalog";
import { outlets } from "../db/schema/org";
import { payments } from "../db/schema/payments";
import { purchaseBills } from "../db/schema/purchasing";
import { db } from "../lib/db";
import type { Tx } from "../lib/db";
import { freshDocNumber } from "../lib/doc-number";
import { requireCapability } from "./rbac";
import type { StaffActor } from "./rbac";

type PaymentRow = typeof payments.$inferSelect;
type BillRow = typeof purchaseBills.$inferSelect;

export type RecordPaymentInput = {
  direction: string;
  partyType: string;
  partyId: string;
  invoiceId?: string | null;
  purchaseBillId?: string | null;
  returnId?: string | null;
  amountPaise: number;
  mode: string;
  outletId: string;
};

/**
 * The one payment write path (`api.md` §7), shared across every payment
 * context — vendor bills here, sales/refunds/gateway in the later phases.
 * Phase 6 supports the vendor context: `direction=out`, `partyType=vendor`,
 * linked to a purchase bill; everything else is `400 unsupported payment
 * context` until its phase lands.
 *
 * R3 cap (`architecture.md` §4.3/§4.4): the bill's outstanding balance is
 * re-derived in-transaction as `bill.total − Σ payments(direction='out',
 * linked to the bill)` — never cached, never client-supplied — and an
 * amount above it throws `409 over_payment`, rolling back the whole
 * transaction (zero payment rows survive). The vendor party is never trusted
 * from the payload: `partyId` must equal the bill's own `vendorId`.
 * `payments` is a [FACT] table — insert-only, trigger-protected, and it does
 * not write `audit_events` (architecture.md §4.12).
 */
export function recordPayment(tx: Tx, actor: StaffActor, input: RecordPaymentInput): PaymentRow {
  requireCapability(actor, "canManagePayments", input.outletId);
  const outlet = tx.select({ id: outlets.id }).from(outlets).where(eq(outlets.id, input.outletId)).get();
  if (!outlet) throw new HTTPException(404, { message: "not_found" });
  const links = [input.invoiceId, input.purchaseBillId, input.returnId].filter((l) => l != null && l !== "");
  if (links.length !== 1) {
    throw new HTTPException(400, { message: "exactly one document link required" });
  }
  if (input.direction !== "out" || input.partyType !== "vendor" || !input.purchaseBillId) {
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
  const paidRow = tx
    .select({ total: sql<number>`coalesce(sum(${payments.amountPaise}), 0)` })
    .from(payments)
    .where(and(eq(payments.direction, "out"), eq(payments.purchaseBillId, bill.id)))
    .get();
  const paid = paidRow?.total ?? 0;
  const outstanding = bill.totalPaise - paid;
  if (input.amountPaise > outstanding) {
    throw new HTTPException(409, { message: "over_payment" });
  }
  const now = Date.now();
  const paymentNumber = freshDocNumber("PY", (n) =>
    Boolean(tx.select({ id: payments.id }).from(payments).where(eq(payments.paymentNumber, n)).get()),
  );
  const row: PaymentRow = {
    id: randomUUIDv7(),
    paymentNumber,
    direction: input.direction,
    partyType: input.partyType,
    partyId: bill.vendorId,
    invoiceId: null,
    purchaseBillId: bill.id,
    returnId: null,
    outletId: input.outletId,
    amountPaise: input.amountPaise,
    mode: input.mode,
    gateway: null,
    gatewayPaymentId: null,
    gatewayEventId: null,
    status: "confirmed",
    createdAt: now,
  };
  tx.insert(payments).values(row).run();
  return row;
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