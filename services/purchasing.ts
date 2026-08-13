import { randomUUIDv7 } from "bun";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { batches, variants, vendors } from "../db/schema/catalog";
import { outlets } from "../db/schema/org";
import { billCharges, purchaseBillItems, purchaseBills } from "../db/schema/purchasing";
import { db } from "../lib/db";
import type { Tx } from "../lib/db";
import { freshDocNumber } from "../lib/doc-number";
import { computeLineTotalPaise, computeTaxAmountPaise } from "../lib/money";
import { writeAuditEvent } from "./audit";
import { requireCapability } from "./rbac";
import type { StaffActor } from "./rbac";
import { writeMovement } from "./stock";

type VendorRow = typeof vendors.$inferSelect;
type BillRow = typeof purchaseBills.$inferSelect;
type BillItemRow = typeof purchaseBillItems.$inferSelect;
type BillChargeRow = typeof billCharges.$inferSelect;
type BatchRow = typeof batches.$inferSelect;

export type CreateVendorInput = {
  name: string;
  phone: string;
  gstin?: string | null;
};

/**
 * Vendor master data (`api.md` §5). A vendor is reference data, so the
 * mutation writes an `audit_events` row (architecture.md §4.12 — vendors
 * joined the audited list with this phase). No update route is documented
 * (`api.md` §5 lists GET/POST only).
 */
export function createVendor(tx: Tx, actor: StaffActor, input: CreateVendorInput): VendorRow {
  requireCapability(actor, "canManagePurchases");
  const now = Date.now();
  const row: VendorRow = {
    id: randomUUIDv7(),
    name: input.name,
    phone: input.phone,
    gstin: input.gstin ?? null,
    isActive: 1,
    createdAt: now,
    updatedAt: now,
  };
  tx.insert(vendors).values(row).run();
  writeAuditEvent(tx, {
    entityType: "vendor",
    entityId: row.id,
    action: "created",
    actorId: actor.userId,
    actorType: "staff",
    before: null,
    after: { ...row },
  });
  return row;
}

export function listVendors(opts: { page: number; pageSize: number }): { rows: VendorRow[]; total: number } {
  const total = db.select({ n: count() }).from(vendors).get()?.n ?? 0;
  const rows = db
    .select()
    .from(vendors)
    .orderBy(desc(vendors.createdAt), desc(vendors.id))
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize)
    .all();
  return { rows, total };
}

export type BillLineInput = {
  variantId: string;
  batchNumber?: string | null;
  quantity: number;
  unitCostPaise: number;
  taxRatePct: number;
};

export type BillChargeInput = {
  name: string;
  amountPaise: number;
};

export type CreateBillInput = {
  vendorId: string;
  outletId: string;
  items: BillLineInput[];
  charges?: BillChargeInput[];
};

export type UpdateBillInput = CreateBillInput & { version: number };

function computeLineMoney(unitCostPaise: number, quantity: number, taxRatePct: number): { taxAmountPaise: number; lineTotalPaise: number } {
  return {
    taxAmountPaise: computeTaxAmountPaise(unitCostPaise, quantity, taxRatePct),
    lineTotalPaise: computeLineTotalPaise(unitCostPaise, quantity, taxRatePct),
  };
}

/**
 * Header totals are always derived from the line/charge snapshots, never
 * client-supplied (architecture.md §4.4, I4): `subtotal = Σ unitCost×qty`,
 * `tax = Σ line tax`, `total = subtotal + tax + Σ signed charges`. `total ≥ 0`
 * is enforced at issue, not before — a draft may be transiently negative.
 */
function computeBillTotals(
  items: { unitCostPaise: number; quantity: number; taxAmountPaise: number }[],
  charges: { amountPaise: number }[],
): { subtotalPaise: number; taxPaise: number; totalPaise: number } {
  const subtotalPaise = items.reduce((s, i) => s + i.unitCostPaise * i.quantity, 0);
  const taxPaise = items.reduce((s, i) => s + i.taxAmountPaise, 0);
  const totalPaise = subtotalPaise + taxPaise + charges.reduce((s, c) => s + c.amountPaise, 0);
  return { subtotalPaise, taxPaise, totalPaise };
}

/**
 * Validates a draft's line set: every variant must exist (404), quantities
 * positive, unit cost non-negative, tax rate an integer percent in 0–100, and
 * the `(variantId, batchNumber)` pairs distinct within the document.
 * `batchNumber` is draft intent (`schema.md` §5.2) — resolved to a batch only
 * at issue.
 */
function assertBillLines(tx: Tx, items: BillLineInput[]): void {
  const seen = new Set<string>();
  for (const line of items) {
    if (line.quantity < 1) {
      throw new HTTPException(400, { message: "quantity must be positive" });
    }
    if (line.unitCostPaise < 0) {
      throw new HTTPException(400, { message: "unit cost must be non-negative" });
    }
    if (line.taxRatePct < 0 || line.taxRatePct > 100) {
      throw new HTTPException(400, { message: "tax rate must be an integer percent 0-100" });
    }
    const key = `${line.variantId}\u0000${line.batchNumber ?? ""}`;
    if (seen.has(key)) {
      throw new HTTPException(400, { message: "duplicate line" });
    }
    seen.add(key);
    const variant = tx.select({ id: variants.id }).from(variants).where(eq(variants.id, line.variantId)).get();
    if (!variant) throw new HTTPException(404, { message: "not_found" });
  }
}

function assertBillCharges(charges: BillChargeInput[]): void {
  for (const charge of charges) {
    if (charge.name.length === 0) {
      throw new HTTPException(400, { message: "charge name required" });
    }
  }
}

function insertBillItems(tx: Tx, billId: string, items: BillLineInput[]): BillItemRow[] {
  return items.map((line) => {
    const money = computeLineMoney(line.unitCostPaise, line.quantity, line.taxRatePct);
    const row: BillItemRow = {
      id: randomUUIDv7(),
      purchaseBillId: billId,
      variantId: line.variantId,
      batchId: null,
      batchNumber: line.batchNumber ?? null,
      quantity: line.quantity,
      unitCostPaise: line.unitCostPaise,
      taxRatePct: line.taxRatePct,
      taxAmountPaise: money.taxAmountPaise,
      lineTotalPaise: money.lineTotalPaise,
    };
    tx.insert(purchaseBillItems).values(row).run();
    return row;
  });
}

function insertBillCharges(tx: Tx, billId: string, charges: BillChargeInput[]): BillChargeRow[] {
  return charges.map((charge) => {
    const row: BillChargeRow = {
      id: randomUUIDv7(),
      purchaseBillId: billId,
      name: charge.name,
      amountPaise: charge.amountPaise,
    };
    tx.insert(billCharges).values(row).run();
    return row;
  });
}

/**
 * Draft vendor bill (`api.md` §5) — header + line/charge snapshots in one
 * transaction. Line money is computed here from the client-originable
 * `unitCostPaise`/`quantity`/`taxRatePct` (architecture.md §4.4 closed list);
 * header totals are derived from the lines just written. Scoped to the bill's
 * own outlet.
 */
export function createBill(tx: Tx, actor: StaffActor, input: CreateBillInput): BillRow & { items: BillItemRow[]; charges: BillChargeRow[] } {
  requireCapability(actor, "canManagePurchases", input.outletId);
  const vendor = tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, input.vendorId)).get();
  if (!vendor) throw new HTTPException(404, { message: "not_found" });
  const outlet = tx.select({ id: outlets.id }).from(outlets).where(eq(outlets.id, input.outletId)).get();
  if (!outlet) throw new HTTPException(404, { message: "not_found" });
  assertBillLines(tx, input.items);
  const charges = input.charges ?? [];
  assertBillCharges(charges);
  const now = Date.now();
  const billNumber = freshDocNumber("BL", (n) =>
    Boolean(tx.select({ id: purchaseBills.id }).from(purchaseBills).where(eq(purchaseBills.billNumber, n)).get()),
  );
  const row: BillRow = {
    id: randomUUIDv7(),
    billNumber,
    vendorId: input.vendorId,
    outletId: input.outletId,
    status: "draft",
    subtotalPaise: 0,
    taxPaise: 0,
    totalPaise: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  tx.insert(purchaseBills).values(row).run();
  const items = insertBillItems(tx, row.id, input.items);
  const chargeRows = insertBillCharges(tx, row.id, charges);
  const totals = computeBillTotals(items, chargeRows);
  tx.update(purchaseBills)
    .set({ ...totals })
    .where(eq(purchaseBills.id, row.id))
    .run();
  return { ...row, ...totals, items, charges: chargeRows };
}

/**
 * Draft-only, versioned edit (race R5): full-replace of the line/charge set
 * with a version bump via `WHERE id AND version` — 0 rows changed → the client
 * saw a stale version. Scoped to the draft's own outlet.
 */
export function updateBill(
  tx: Tx,
  actor: StaffActor,
  billId: string,
  input: UpdateBillInput,
): BillRow & { items: BillItemRow[]; charges: BillChargeRow[] } {
  requireCapability(actor, "canManagePurchases", input.outletId);
  const existing = tx.select().from(purchaseBills).where(eq(purchaseBills.id, billId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  if (existing.status !== "draft") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  if (input.version !== existing.version) {
    throw new HTTPException(409, { message: "stale_version" });
  }
  const vendor = tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, input.vendorId)).get();
  if (!vendor) throw new HTTPException(404, { message: "not_found" });
  const outlet = tx.select({ id: outlets.id }).from(outlets).where(eq(outlets.id, input.outletId)).get();
  if (!outlet) throw new HTTPException(404, { message: "not_found" });
  assertBillLines(tx, input.items);
  const charges = input.charges ?? [];
  assertBillCharges(charges);
  const now = Date.now();
  tx.update(purchaseBills)
    .set({ vendorId: input.vendorId, outletId: input.outletId, version: existing.version + 1, updatedAt: now })
    .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.version, input.version)))
    .run();
  tx.delete(purchaseBillItems).where(eq(purchaseBillItems.purchaseBillId, billId)).run();
  tx.delete(billCharges).where(eq(billCharges.purchaseBillId, billId)).run();
  const items = insertBillItems(tx, billId, input.items);
  const chargeRows = insertBillCharges(tx, billId, charges);
  const totals = computeBillTotals(items, chargeRows);
  tx.update(purchaseBills)
    .set({ ...totals })
    .where(eq(purchaseBills.id, billId))
    .run();
  const next: BillRow = {
    ...existing,
    vendorId: input.vendorId,
    outletId: input.outletId,
    ...totals,
    version: existing.version + 1,
    updatedAt: now,
  };
  return { ...next, items, charges: chargeRows };
}

/**
 * Create-or-reuse (`api.md` §5, R6): a batch is keyed by
 * `(variantId, batchNumber)` — an existing batch is reused untouched, a
 * missing one is created with `costPricePaise = unitCostPaise` (the vendor's
 * invoice is the world, §4.4). Batch creation is an audited mutation
 * (architecture.md §4.12); reuse is not. The `UNIQUE(variantId, batchNumber)`
 * backstop converts a racing duplicate into `409 duplicate_batch`.
 */
function findOrCreateBatch(tx: Tx, actor: StaffActor, variantId: string, batchNumber: string, costPricePaise: number): BatchRow {
  const existing = tx
    .select()
    .from(batches)
    .where(and(eq(batches.variantId, variantId), eq(batches.batchNumber, batchNumber)))
    .get();
  if (existing) return existing;
  const row: BatchRow = {
    id: randomUUIDv7(),
    variantId,
    batchNumber,
    expiryDate: null,
    costPricePaise,
    isActive: 1,
    createdAt: Date.now(),
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

/**
 * `draft → issued` (`architecture.md` §4.7), one transaction, one-shot:
 * every line must carry a `batchNumber` (the create-or-reuse key — 400 if
 * absent), batches are created-or-reused, line money is re-derived from the
 * stored snapshots (I4 — never the draft's stored totals, and never a
 * client-supplied total), header totals are recomputed, `total ≥ 0` enforced,
 * then exactly one `purchase` in-movement is written per line (fact rows
 * before the header state flip, T3). Re-issue → `409 already_issued`, zero
 * rows. Unwinding is purchase returns + vendor refunds — never void.
 */
export function issueBill(tx: Tx, actor: StaffActor, billId: string): BillRow {
  const existing = tx.select().from(purchaseBills).where(eq(purchaseBills.id, billId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManagePurchases", existing.outletId);
  if (existing.status !== "draft") {
    throw new HTTPException(409, { message: "already_issued" });
  }
  const lines = tx
    .select()
    .from(purchaseBillItems)
    .where(eq(purchaseBillItems.purchaseBillId, billId))
    .orderBy(asc(purchaseBillItems.id))
    .all();
  const charges = tx
    .select()
    .from(billCharges)
    .where(eq(billCharges.purchaseBillId, billId))
    .orderBy(asc(billCharges.id))
    .all();
  const resolved: { line: BillItemRow; batchId: string }[] = [];
  for (const line of lines) {
    if (!line.batchNumber) {
      throw new HTTPException(400, { message: "batch number required" });
    }
    const batch = findOrCreateBatch(tx, actor, line.variantId, line.batchNumber, line.unitCostPaise);
    resolved.push({ line, batchId: batch.id });
  }
  const updatedLines = resolved.map(({ line, batchId }) => {
    const money = computeLineMoney(line.unitCostPaise, line.quantity, line.taxRatePct);
    tx.update(purchaseBillItems)
      .set({ batchId, taxAmountPaise: money.taxAmountPaise, lineTotalPaise: money.lineTotalPaise })
      .where(eq(purchaseBillItems.id, line.id))
      .run();
    return { ...line, batchId, ...money };
  });
  const totals = computeBillTotals(updatedLines, charges);
  if (totals.totalPaise < 0) {
    throw new HTTPException(400, { message: "total must be non-negative" });
  }
  for (const line of updatedLines) {
    writeMovement(tx, {
      variantId: line.variantId,
      outletId: existing.outletId,
      batchId: line.batchId!,
      delta: line.quantity,
      reason: "purchase",
      sourceType: "purchase",
      sourceId: billId,
    });
  }
  const now = Date.now();
  tx.update(purchaseBills)
    .set({ status: "issued", ...totals, updatedAt: now })
    .where(eq(purchaseBills.id, billId))
    .run();
  return { ...existing, status: "issued", ...totals, updatedAt: now };
}

/**
 * `void` exists only on drafts (`architecture.md` §4.7) — a draft bill has no
 * movements, so voiding never touches stock. An issued bill is unwound by
 * purchase returns + vendor refunds, never by voiding.
 */
export function voidBill(tx: Tx, actor: StaffActor, billId: string): BillRow {
  const existing = tx.select().from(purchaseBills).where(eq(purchaseBills.id, billId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManagePurchases", existing.outletId);
  if (existing.status !== "draft") {
    throw new HTTPException(409, { message: "invalid_transition" });
  }
  const now = Date.now();
  tx.update(purchaseBills)
    .set({ status: "void", updatedAt: now })
    .where(eq(purchaseBills.id, billId))
    .run();
  return { ...existing, status: "void", updatedAt: now };
}

export function listBills(opts: { page: number; pageSize: number }): { rows: BillRow[]; total: number } {
  const total = db.select({ n: count() }).from(purchaseBills).get()?.n ?? 0;
  const rows = db
    .select()
    .from(purchaseBills)
    .orderBy(desc(purchaseBills.createdAt), desc(purchaseBills.id))
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize)
    .all();
  return { rows, total };
}

export function getBill(billId: string): (BillRow & { items: BillItemRow[]; charges: BillChargeRow[] }) | null {
  const header = db.select().from(purchaseBills).where(eq(purchaseBills.id, billId)).get();
  if (!header) return null;
  const items = db
    .select()
    .from(purchaseBillItems)
    .where(eq(purchaseBillItems.purchaseBillId, billId))
    .orderBy(asc(purchaseBillItems.id))
    .all();
  const charges = db
    .select()
    .from(billCharges)
    .where(eq(billCharges.purchaseBillId, billId))
    .orderBy(asc(billCharges.id))
    .all();
  return { ...header, items, charges };
}