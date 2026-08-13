import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";

process.env.NODE_ENV = "test";
const tmpPath = join("data", `smoke-purchasing-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.AUTH_SECRET = "smoke-purchasing-secret";
process.env.SUPERUSER_EMAIL = "admin@purchasing.test";
process.env.SUPERUSER_PASSWORD = "admin-pass-123";

mkdirSync(dirname(tmpPath), { recursive: true });

const { logger } = await import("../lib/logger");
const log = logger.child({ module: "smoke-purchasing" });
const failures: string[] = [];

const { db } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");
const { bootstrapAdmin } = await import("../lib/auth");
const { app } = await import("../app");
const { batches } = await import("../db/schema/catalog");
const { stockLevels, stockMovements } = await import("../db/schema/inventory");
const { outlets } = await import("../db/schema/org");
const { payments } = await import("../db/schema/payments");

applyMigrations(db);
await bootstrapAdmin();

function assert(cond: boolean, msg: string): void {
  if (!cond) failures.push(msg);
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => c.length > 0)
    .join("; ");
}

async function signIn(): Promise<string> {
  const res = await app.fetch(
    new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@purchasing.test", password: "admin-pass-123" }),
    }),
  );
  assert(res.status === 200, `sign-in status ${res.status}`);
  return cookiesOf(res);
}

async function api(
  cookies: string,
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    cookie: cookies,
    "content-type": "application/json",
  };
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    }),
  );
}

type Envelope = {
  error?: { code?: string; message?: string; reason?: string; details?: unknown[] };
  data?: unknown[];
  pagination?: unknown;
  [key: string]: unknown;
};

async function body(res: Response): Promise<Envelope> {
  return (await res.json()) as Envelope;
}

function stockAt(outletId: string, batchId: string): number {
  const row = db
    .select({ qty: stockLevels.quantity })
    .from(stockLevels)
    .where(and(eq(stockLevels.outletId, outletId), eq(stockLevels.batchId, batchId)))
    .get();
  return row?.qty ?? 0;
}

function countMovementsFor(sourceId: string): number {
  return db
    .select({ n: stockMovements.id })
    .from(stockMovements)
    .where(and(eq(stockMovements.sourceType, "purchase"), eq(stockMovements.sourceId, sourceId)))
    .all().length;
}

function countBatchesFor(variantId: string): number {
  return db.select({ n: batches.id }).from(batches).where(eq(batches.variantId, variantId)).all().length;
}

function batchOf(variantId: string, batchNumber: string) {
  return db
    .select()
    .from(batches)
    .where(and(eq(batches.variantId, variantId), eq(batches.batchNumber, batchNumber)))
    .get();
}

function countPayments(): number {
  return db.select({ n: payments.id }).from(payments).all().length;
}

async function scenario(): Promise<void> {
  const cookies = await signIn();

  const outlet = db.select().from(outlets).where(eq(outlets.name, "Main Outlet")).get();
  assert(outlet !== undefined, "bootstrap outlet missing");
  if (!outlet) return;

  const vendorRes = await api(cookies, "/api/vendors", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "Acme Supplies", phone: "9876543210", gstin: "29AABCS1234F1Z5" },
  });
  assert(vendorRes.status === 200, `create vendor: ${vendorRes.status}`);
  const vendor = (await body(vendorRes)) as { id: string; name: string; isActive: number };
  assert(vendor.name === "Acme Supplies" && vendor.isActive === 1, "vendor fields wrong");

  const vendor2Res = await api(cookies, "/api/vendors", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "Other Vendor", phone: "9123456780" },
  });
  assert(vendor2Res.status === 200, `create vendor 2: ${vendor2Res.status}`);
  const vendor2 = (await body(vendor2Res)) as { id: string };

  const vendorList = await api(cookies, "/api/vendors");
  assert(vendorList.status === 200, `vendor list: ${vendorList.status}`);
  const vendorListBody = (await body(vendorList)) as { data: unknown[]; pagination: unknown };
  assert(vendorListBody.data?.length === 2, "vendor list must contain both vendors");
  assert(vendorListBody.pagination !== undefined, "vendor list missing pagination");

  const productRes = await api(cookies, "/api/products", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      name: "Purchasing Soda",
      hsnCode: "22021010",
      gstRatePct: 12,
      baseVariant: { name: "Purchasing Soda 500ml", sku: "PS-500", costPricePaise: 1500, sellingPricePaise: 2400 },
    },
  });
  assert(productRes.status === 200, `create product: ${productRes.status}`);
  const product = (await body(productRes)) as { baseVariant: { id: string } };
  const variantId = product.baseVariant.id;

  const preBatchRes = await api(cookies, "/api/inventory/batches", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { variantId, batchNumber: "BP-EXIST", costPricePaise: 1200 },
  });
  assert(preBatchRes.status === 200, `create pre-existing batch: ${preBatchRes.status}`);
  const preBatch = (await body(preBatchRes)) as { id: string };

  const billRes = await api(cookies, "/api/purchase-bills", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      vendorId: vendor.id,
      outletId: outlet.id,
      items: [
        { variantId, batchNumber: "BP-NEW1", quantity: 10, unitCostPaise: 1500, taxRatePct: 12 },
        { variantId, batchNumber: "BP-NEW2", quantity: 5, unitCostPaise: 2000, taxRatePct: 18 },
        { variantId, batchNumber: "BP-EXIST", quantity: 8, unitCostPaise: 1200, taxRatePct: 0 },
      ],
      charges: [
        { name: "freight", amountPaise: 5000 },
        { name: "discount", amountPaise: -2000 },
      ],
    },
  });
  assert(billRes.status === 200, `create bill: ${billRes.status}`);
  const bill = (await body(billRes)) as {
    id: string;
    status: string;
    version: number;
    subtotalPaise: number;
    taxPaise: number;
    totalPaise: number;
    items: { taxAmountPaise: number; lineTotalPaise: number; batchId: string | null }[];
    charges: unknown[];
  };
  assert(bill.status === "draft", "bill must start as draft");
  assert(bill.version === 1, "bill must start at version 1");
  assert(bill.subtotalPaise === 34600, `draft subtotal ${bill.subtotalPaise} != 34600`);
  assert(bill.taxPaise === 3600, `draft tax ${bill.taxPaise} != 3600`);
  assert(bill.totalPaise === 41200, `draft total ${bill.totalPaise} != 41200`);
  assert(bill.items.length === 3, "bill must carry 3 lines");
  assert(bill.items[0]?.taxAmountPaise === 1800 && bill.items[0]?.lineTotalPaise === 16800, "line 1 money (floor-tax) wrong");
  assert(bill.items[1]?.taxAmountPaise === 1800 && bill.items[1]?.lineTotalPaise === 11800, "line 2 money (floor-tax) wrong");
  assert(bill.items[2]?.taxAmountPaise === 0 && bill.items[2]?.lineTotalPaise === 9600, "line 3 money wrong");
  assert(bill.items.every((i) => i.batchId === null), "draft lines must not resolve batches yet");
  assert(bill.charges.length === 2, "bill must carry 2 charges");
  assert(countMovementsFor(bill.id) === 0, "draft must write zero movements");
  assert(stockAt(outlet.id, preBatch.id) === 0, "draft must not touch stock");

  const stalePut = await api(cookies, `/api/purchase-bills/${bill.id}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: {
      vendorId: vendor.id,
      outletId: outlet.id,
      items: [{ variantId, batchNumber: "BP-NEW1", quantity: 12, unitCostPaise: 1500, taxRatePct: 12 }],
      version: 99,
    },
  });
  assert(stalePut.status === 409, `stale PUT must be 409, got ${stalePut.status}`);
  assert(((await body(stalePut)) as Envelope).error?.reason === "stale_version", "stale_version reason mismatch");

  const putRes = await api(cookies, `/api/purchase-bills/${bill.id}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: {
      vendorId: vendor.id,
      outletId: outlet.id,
      items: [
        { variantId, batchNumber: "BP-NEW1", quantity: 12, unitCostPaise: 1500, taxRatePct: 12 },
        { variantId, batchNumber: "BP-NEW2", quantity: 5, unitCostPaise: 2000, taxRatePct: 18 },
        { variantId, batchNumber: "BP-EXIST", quantity: 8, unitCostPaise: 1200, taxRatePct: 0 },
      ],
      charges: [
        { name: "freight", amountPaise: 5000 },
        { name: "discount", amountPaise: -2000 },
      ],
      version: 1,
    },
  });
  assert(putRes.status === 200, `versioned PUT: ${putRes.status}`);
  const putBill = (await body(putRes)) as { version: number; subtotalPaise: number; taxPaise: number; totalPaise: number };
  assert(putBill.version === 2, "PUT must bump version to 2");
  assert(putBill.subtotalPaise === 37600 && putBill.taxPaise === 3960 && putBill.totalPaise === 44560, "PUT must recompute totals");

  const issueRes = await api(cookies, `/api/purchase-bills/${bill.id}/issue`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(issueRes.status === 200, `issue bill: ${issueRes.status}`);
  const issued = (await body(issueRes)) as { status: string; subtotalPaise: number; taxPaise: number; totalPaise: number };
  assert(issued.status === "issued", "bill must become issued");
  assert(issued.subtotalPaise === 37600 && issued.taxPaise === 3960 && issued.totalPaise === 44560, "issue totals wrong");
  assert(countMovementsFor(bill.id) === 3, "3-line bill must write exactly 3 movements");
  assert(stockAt(outlet.id, preBatch.id) === 8, "reused batch stock wrong");

  const new1 = batchOf(variantId, "BP-NEW1");
  const new2 = batchOf(variantId, "BP-NEW2");
  assert(new1 !== undefined && new1.costPricePaise === 1500, "BP-NEW1 must be created with the line's unit cost");
  assert(new2 !== undefined && new2.costPricePaise === 2000, "BP-NEW2 must be created with the line's unit cost");
  assert(batchOf(variantId, "BP-EXIST")?.id === preBatch.id, "BP-EXIST must be reused, not recreated");
  assert(countBatchesFor(variantId) === 3, "issue must create-or-reuse exactly 3 batches total");
  assert(stockAt(outlet.id, new1!.id) === 12 && stockAt(outlet.id, new2!.id) === 5, "new batch stock wrong");

  const detail = await api(cookies, `/api/purchase-bills/${bill.id}`);
  assert(detail.status === 200, `bill detail: ${detail.status}`);
  const detailBody = (await body(detail)) as { items: { batchId: string | null }[] };
  assert(detailBody.items.every((i) => i.batchId !== null), "issued lines must all carry resolved batchIds");

  const movementsBeforeReissue = countMovementsFor(bill.id);
  const reissue = await api(cookies, `/api/purchase-bills/${bill.id}/issue`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(reissue.status === 409, `re-issue must be 409, got ${reissue.status}`);
  assert(((await body(reissue)) as Envelope).error?.reason === "already_issued", "already_issued reason mismatch");
  assert(countMovementsFor(bill.id) === movementsBeforeReissue, "re-issue must write zero duplicate movements");

  const editIssued = await api(cookies, `/api/purchase-bills/${bill.id}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: {
      vendorId: vendor.id,
      outletId: outlet.id,
      items: [{ variantId, batchNumber: "BP-NEW1", quantity: 1, unitCostPaise: 1500, taxRatePct: 12 }],
      version: 2,
    },
  });
  assert(editIssued.status === 409, `PUT on issued bill must be 409, got ${editIssued.status}`);

  const voidIssued = await api(cookies, `/api/purchase-bills/${bill.id}/void`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(voidIssued.status === 409, `void on issued bill must be 409, got ${voidIssued.status}`);

  const bill2Res = await api(cookies, "/api/purchase-bills", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      vendorId: vendor.id,
      outletId: outlet.id,
      items: [{ variantId, batchNumber: "BP-EXIST", quantity: 2, unitCostPaise: 1300, taxRatePct: 0 }],
    },
  });
  const bill2 = (await body(bill2Res)) as { id: string };
  const issue2 = await api(cookies, `/api/purchase-bills/${bill2.id}/issue`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(issue2.status === 200, `issue bill 2: ${issue2.status}`);
  assert(countMovementsFor(bill2.id) === 1, "bill 2 must write exactly 1 movement");
  assert(batchOf(variantId, "BP-EXIST")?.costPricePaise === 1200, "reused batch must stay untouched");
  assert(stockAt(outlet.id, preBatch.id) === 10, "reused batch stock must accumulate");

  const draftBill = await api(cookies, "/api/purchase-bills", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      vendorId: vendor.id,
      outletId: outlet.id,
      items: [{ variantId, batchNumber: "BP-VOID", quantity: 1, unitCostPaise: 1000, taxRatePct: 0 }],
    },
  });
  const draftBody = (await body(draftBill)) as { id: string };
  const voidRes = await api(cookies, `/api/purchase-bills/${draftBody.id}/void`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(voidRes.status === 200, `void draft bill: ${voidRes.status}`);
  const voidAgain = await api(cookies, `/api/purchase-bills/${draftBody.id}/void`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(voidAgain.status === 409, `void on voided bill must be 409, got ${voidAgain.status}`);
  const issueVoided = await api(cookies, `/api/purchase-bills/${draftBody.id}/issue`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(issueVoided.status === 409, `issue on voided bill must be 409, got ${issueVoided.status}`);
  assert(countMovementsFor(draftBody.id) === 0, "voided bill must never write movements");

  const noBatchBill = await api(cookies, "/api/purchase-bills", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      vendorId: vendor.id,
      outletId: outlet.id,
      items: [{ variantId, quantity: 3, unitCostPaise: 900, taxRatePct: 0 }],
    },
  });
  assert(noBatchBill.status === 200, `create bill without batchNumber: ${noBatchBill.status}`);
  const noBatchDoc = (await body(noBatchBill)) as { id: string };
  const noBatchIssue = await api(cookies, `/api/purchase-bills/${noBatchDoc.id}/issue`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(noBatchIssue.status === 400, `issue without batchNumber must be 400, got ${noBatchIssue.status}`);
  assert(countMovementsFor(noBatchDoc.id) === 0, "batchless issue must write zero movements");

  const billList = await api(cookies, "/api/purchase-bills");
  assert(billList.status === 200, `bill list: ${billList.status}`);
  const billListBody = (await body(billList)) as { data: unknown[]; pagination: unknown };
  assert(billListBody.data?.length === 4, "bill list must contain 4 bills");
  assert(billListBody.pagination !== undefined, "bill list missing pagination");

  const payPartial = await api(cookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      direction: "out",
      partyType: "vendor",
      partyId: vendor.id,
      purchaseBillId: bill.id,
      amountPaise: 20000,
      mode: "upi",
      outletId: outlet.id,
    },
  });
  assert(payPartial.status === 200, `partial vendor payment: ${payPartial.status}`);
  const payment = (await body(payPartial)) as { id: string; status: string; direction: string; partyType: string; amountPaise: number; mode: string; paymentNumber: string };
  assert(payment.status === "confirmed" && payment.direction === "out" && payment.partyType === "vendor", "payment row fields wrong");
  assert(payment.amountPaise === 20000 && payment.mode === "upi", "payment amount/mode wrong");
  assert(payment.paymentNumber.startsWith("PY-"), "payment number prefix wrong");
  assert(countPayments() === 1, "exactly one payment row after partial");

  const overPay = await api(cookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      direction: "out",
      partyType: "vendor",
      partyId: vendor.id,
      purchaseBillId: bill.id,
      amountPaise: 30000,
      mode: "cash",
      outletId: outlet.id,
    },
  });
  assert(overPay.status === 409, `over-payment must be 409, got ${overPay.status}`);
  assert(((await body(overPay)) as Envelope).error?.reason === "over_payment", "over_payment reason mismatch");
  assert(countPayments() === 1, "over-payment must leave zero rows behind");

  const payRest = await api(cookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      direction: "out",
      partyType: "vendor",
      partyId: vendor.id,
      purchaseBillId: bill.id,
      amountPaise: 24560,
      mode: "bank",
      outletId: outlet.id,
    },
  });
  assert(payRest.status === 200, `remaining vendor payment: ${payRest.status}`);
  assert(countPayments() === 2, "exactly two payment rows after remainder");

  const payAfterSettled = await api(cookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      direction: "out",
      partyType: "vendor",
      partyId: vendor.id,
      purchaseBillId: bill.id,
      amountPaise: 1,
      mode: "cash",
      outletId: outlet.id,
    },
  });
  assert(payAfterSettled.status === 409, `payment on settled bill must be 409, got ${payAfterSettled.status}`);
  assert(countPayments() === 2, "settled-bill payment must leave zero rows behind");

  const payDraft = await api(cookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      direction: "out",
      partyType: "vendor",
      partyId: vendor.id,
      purchaseBillId: draftBody.id,
      amountPaise: 100,
      mode: "cash",
      outletId: outlet.id,
    },
  });
  assert(payDraft.status === 409, `payment on draft bill must be 409, got ${payDraft.status}`);
  assert(((await body(payDraft)) as Envelope).error?.reason === "invalid_transition", "draft-bill payment reason mismatch");

  const payNoLink = await api(cookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "out", partyType: "vendor", partyId: vendor.id, amountPaise: 100, mode: "cash", outletId: outlet.id },
  });
  assert(payNoLink.status === 400, `payment without document link must be 400, got ${payNoLink.status}`);

  const payUnsupported = await api(cookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      direction: "in",
      partyType: "customer",
      partyId: vendor.id,
      purchaseBillId: bill.id,
      amountPaise: 100,
      mode: "cash",
      outletId: outlet.id,
    },
  });
  assert(payUnsupported.status === 400, `unsupported payment context must be 400, got ${payUnsupported.status}`);

  const payBadVendor = await api(cookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      direction: "out",
      partyType: "vendor",
      partyId: randomUUIDv7(),
      purchaseBillId: bill.id,
      amountPaise: 100,
      mode: "cash",
      outletId: outlet.id,
    },
  });
  assert(payBadVendor.status === 404, `payment with unknown vendor must be 404, got ${payBadVendor.status}`);

  const payPartyMismatch = await api(cookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      direction: "out",
      partyType: "vendor",
      partyId: vendor2.id,
      purchaseBillId: bill.id,
      amountPaise: 100,
      mode: "cash",
      outletId: outlet.id,
    },
  });
  assert(payPartyMismatch.status === 400, `party/bill mismatch must be 400, got ${payPartyMismatch.status}`);

  const payBadBill = await api(cookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      direction: "out",
      partyType: "vendor",
      partyId: vendor.id,
      purchaseBillId: randomUUIDv7(),
      amountPaise: 100,
      mode: "cash",
      outletId: outlet.id,
    },
  });
  assert(payBadBill.status === 404, `payment with unknown bill must be 404, got ${payBadBill.status}`);

  const payGatewayMode = await api(cookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      direction: "out",
      partyType: "vendor",
      partyId: vendor.id,
      purchaseBillId: bill.id,
      amountPaise: 100,
      mode: "gateway",
      outletId: outlet.id,
    },
  });
  assert(payGatewayMode.status === 400, `gateway mode must be 400 until the payments phase, got ${payGatewayMode.status}`);

  const payList = await api(cookies, `/api/payments?direction=out&partyType=vendor&partyId=${vendor.id}`);
  assert(payList.status === 200, `payment list: ${payList.status}`);
  const payListBody = (await body(payList)) as { data: unknown[]; pagination: unknown };
  assert(payListBody.data?.length === 2, "payment list must contain 2 rows");
  assert(payListBody.pagination !== undefined, "payment list missing pagination");

  const payRange = await api(cookies, `/api/payments?from=${Date.now() - 60000}&to=${Date.now()}`);
  assert(payRange.status === 200, `payment date range: ${payRange.status}`);
  const payRangeBody = (await body(payRange)) as { data: unknown[] };
  assert(payRangeBody.data?.length === 2, "payment date-range list must contain 2 rows");

  const bill2Paid = db
    .select({ n: payments.id })
    .from(payments)
    .where(eq(payments.purchaseBillId, bill2.id))
    .all();
  assert(bill2Paid.length === 0, "bill 2 must have zero payments");
}

try {
  await scenario();
} catch (err) {
  failures.push(`smoke-purchasing scenario threw: ${String(err)}`);
} finally {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
}

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0], all: failures }, "smoke-purchasing FAILED");
  process.exit(1);
}
log.info("smoke-purchasing PASS");