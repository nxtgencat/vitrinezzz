import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";

process.env.NODE_ENV = "test";
const tmpPath = join("data", `smoke-returns-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.AUTH_SECRET = "smoke-returns-secret";
process.env.SUPERUSER_EMAIL = "admin@returns.test";
process.env.SUPERUSER_PASSWORD = "admin-pass-123";

mkdirSync(dirname(tmpPath), { recursive: true });

const { logger } = await import("../lib/logger");
const log = logger.child({ module: "smoke-returns" });
const failures: string[] = [];

const { db } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");
const { bootstrapAdmin } = await import("../lib/auth");
const { app } = await import("../app");
const { batches, customers } = await import("../db/schema/catalog");
const { stockLevels } = await import("../db/schema/inventory");
const { returns } = await import("../db/schema/orders");
const { outlets } = await import("../db/schema/org");

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

async function signIn(email: string, password: string): Promise<string> {
  const res = await app.fetch(
    new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  assert(res.status === 200, `sign-in ${email}: ${res.status}`);
  return cookiesOf(res);
}

async function api(
  cookies: string | null,
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookies) headers["cookie"] = cookies;
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
  [key: string]: unknown;
};

async function body(res: Response): Promise<Envelope> {
  const raw = await res.text();
  try {
    return JSON.parse(raw) as Envelope;
  } catch {
    failures.push(`non-JSON response status=${res.status} body=${raw.slice(0, 300)}`);
    return {};
  }
}

function stockAt(batchId: string, outletId: string): number {
  return db.select({ qty: stockLevels.quantity }).from(stockLevels).where(and(eq(stockLevels.outletId, outletId), eq(stockLevels.batchId, batchId))).get()?.qty ?? 0;
}

function returnCount(): number {
  return db.select({ n: returns.id }).from(returns).all().length;
}

async function scenario(): Promise<void> {
  const staffCookies = await signIn("admin@returns.test", "admin-pass-123");

  const outlet = db.select().from(outlets).where(eq(outlets.name, "Main Outlet")).get();
  assert(outlet !== undefined, "bootstrap outlet missing");
  if (!outlet) return;

  const productRes = await api(staffCookies, "/api/products", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "Return Soda", gstRatePct: 12, baseVariant: { name: "Return Soda 500ml", sku: "RET-500", costPricePaise: 1500, sellingPricePaise: 2400 } },
  });
  assert(productRes.status === 200, `create product: ${productRes.status}`);
  const variantId = ((await body(productRes)) as { baseVariant: { id: string } }).baseVariant.id;

  const vendorRes = await api(staffCookies, "/api/vendors", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "Return Supplies", phone: "9876533333" },
  });
  const vendor = (await body(vendorRes)) as { id: string };

  const billRes = await api(staffCookies, "/api/purchase-bills", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      vendorId: vendor.id,
      outletId: outlet.id,
      items: [{ variantId, batchNumber: "RET-A", quantity: 20, unitCostPaise: 1500, taxRatePct: 0 }],
    },
  });
  const bill = (await body(billRes)) as { id: string };
  const issueBill = await api(staffCookies, `/api/purchase-bills/${bill.id}/issue`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(issueBill.status === 200, `issue bill: ${issueBill.status}`);
  const batch = db.select().from(batches).where(eq(batches.batchNumber, "RET-A")).get();
  assert(batch !== undefined, "seed batch missing");
  if (!batch) return;

  const signUp = await app.fetch(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Returning Shopper", email: "returning@returns.test", password: "returning-pass-1" }),
    }),
  );
  assert(signUp.status === 200, `sign-up: ${signUp.status}`);
  const custCookies = await signIn("returning@returns.test", "returning-pass-1");
  const sessionRes = await api(custCookies, "/api/auth/get-session");
  const session = (await body(sessionRes)) as { user: { id: string } };
  const customerRow = db.select().from(customers).where(eq(customers.userId, session.user.id)).get();
  assert(customerRow !== undefined, "customer row missing");
  if (!customerRow) return;
  const customerId = customerRow.id;

  const addrRes = await api(custCookies, "/api/storefront/addresses", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { label: "Home", line1: "1 Return Street", city: "Pune", state: "MH", pincode: "411001" },
  });
  assert(addrRes.status === 200, `create address: ${addrRes.status}`);
  const address = (await body(addrRes)) as { id: string };

  await api(custCookies, "/api/storefront/cart", {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { variantId, quantity: 5 },
  });
  const codRes = await api(custCookies, "/api/storefront/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { custAddressId: address.id, paymentMode: "cod" },
  });
  assert(codRes.status === 200, `cod checkout: ${codRes.status}`);
  const cod = (await body(codRes)) as { order: { id: string }; invoice: { id: string; totalPaise: number; items: { id: string; quantity: number; unitPricePaise: number; taxAmountPaise: number }[] } };
  const saleOrderId = cod.order.id;
  const saleInvoiceId = cod.invoice.id;
  const saleLineId = cod.invoice.items[0]!.id;
  const saleTotal = cod.invoice.totalPaise;
  assert(stockAt(batch.id, outlet.id) === 15, "sale must consume 5 units");

  const paymentIn = await api(staffCookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "in", partyType: "customer", partyId: customerId, invoiceId: saleInvoiceId, amountPaise: saleTotal, mode: "cash", outletId: outlet.id },
  });
  assert(paymentIn.status === 200, `pay the sale invoice: ${paymentIn.status}`);

  const createRes = await api(staffCookies, "/api/returns", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { returnType: "sales", orderId: saleOrderId, items: [{ originalItemId: saleLineId, quantity: 3 }] },
  });
  assert(createRes.status === 200, `staff create sales return: ${createRes.status}`);
  const draft = (await body(createRes)) as { returns: { id: string; status: string; version: number }; items: { id: string; quantity: number }[] };
  const returnId = draft.returns.id;
  assert(draft.returns.status === "draft" && draft.returns.version === 1, "staff draft header wrong");

  const staleUpdate = await api(staffCookies, `/api/returns/${returnId}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { items: [{ originalItemId: saleLineId, quantity: 1 }], version: 99 },
  });
  assert(staleUpdate.status === 409 && ((await body(staleUpdate)) as Envelope).error?.reason === "stale_version", `stale update must 409 stale_version, got ${staleUpdate.status}`);

  const editRes = await api(staffCookies, `/api/returns/${returnId}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { items: [{ originalItemId: saleLineId, quantity: 2 }], version: 1 },
  });
  assert(editRes.status === 200, `update return: ${editRes.status}`);

  const confirm1 = await api(staffCookies, `/api/returns/${returnId}/confirm`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(confirm1.status === 200, `confirm return: ${confirm1.status}`);
  assert(stockAt(batch.id, outlet.id) === 17, "sales restock must mirror the sale's batch");

  const confirmAgain = await api(staffCookies, `/api/returns/${returnId}/confirm`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(confirmAgain.status === 409, `re-confirm must 409, got ${confirmAgain.status}`);

  const overDraft = await api(staffCookies, "/api/returns", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { returnType: "sales", orderId: saleOrderId, items: [{ originalItemId: saleLineId, quantity: 4 }] },
  });
  assert(overDraft.status === 200, "a 4-unit second draft must be creatable (cap at confirm)");
  const overReturnId = ((await body(overDraft)) as { returns: { id: string } }).returns.id;
  const overConfirm = await api(staffCookies, `/api/returns/${overReturnId}/confirm`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(overConfirm.status === 409 && ((await body(overConfirm)) as Envelope).error?.reason === "over_return", `over-return confirm must 409 over_return, got ${overConfirm.status}`);
  assert(stockAt(batch.id, outlet.id) === 17, "over-return must roll back zero movements");
  assert(returnCount() === 2, "over-return confirm must leave the draft row");

  const goodDraft = await api(staffCookies, "/api/returns", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { returnType: "sales", orderId: saleOrderId, items: [{ originalItemId: saleLineId, quantity: 1 }] },
  });
  const goodReturnId = ((await body(goodDraft)) as { returns: { id: string } }).returns.id;
  const goodConfirm = await api(staffCookies, `/api/returns/${goodReturnId}/confirm`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(goodConfirm.status === 200, `second confirm within cap: ${goodConfirm.status}`);
  assert(stockAt(batch.id, outlet.id) === 18, "second restock must apply");

  const refundValue = 1 * 2400 + 1 * 288;
  const refundRes = await api(staffCookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "out", partyType: "customer", partyId: customerId, returnId: goodReturnId, amountPaise: refundValue, mode: "cash", outletId: outlet.id },
  });
  assert(refundRes.status === 200, `return-linked refund: ${refundRes.status}`);

  const refundOver = await api(staffCookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "out", partyType: "customer", partyId: customerId, returnId: goodReturnId, amountPaise: 1, mode: "cash", outletId: outlet.id },
  });
  assert(refundOver.status === 409 && ((await body(refundOver)) as Envelope).error?.reason === "over_payment", `return refund past value must 409 over_payment, got ${refundOver.status}`);

  const plainRefund = await api(staffCookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "out", partyType: "customer", partyId: customerId, invoiceId: saleInvoiceId, amountPaise: saleTotal - refundValue, mode: "cash", outletId: outlet.id },
  });
  assert(plainRefund.status === 200, `plain refund up to effective balance: ${plainRefund.status}`);

  const plainRefundOver = await api(staffCookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "out", partyType: "customer", partyId: customerId, invoiceId: saleInvoiceId, amountPaise: 1, mode: "cash", outletId: outlet.id },
  });
  assert(plainRefundOver.status === 409, `plain refund must not double-spend the return refund (effective balance), got ${plainRefundOver.status}`);

  const purchaseReturnRes = await api(staffCookies, "/api/returns", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { returnType: "purchase", purchaseBillId: bill.id, items: [{ originalItemId: randomUUIDv7(), quantity: 1 }] },
  });
  assert(purchaseReturnRes.status === 404, `purchase return with unknown original item must 404, got ${purchaseReturnRes.status}`);

  const billDetail = await api(staffCookies, `/api/purchase-bills/${bill.id}`);
  const billBody = (await body(billDetail)) as { items: { id: string; quantity: number }[] };
  const billLineId = billBody.items[0]!.id;

  const purchaseReturn = await api(staffCookies, "/api/returns", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { returnType: "purchase", purchaseBillId: bill.id, items: [{ originalItemId: billLineId, quantity: 4 }] },
  });
  assert(purchaseReturn.status === 200, `create purchase return: ${purchaseReturn.status}`);
  const purchaseReturnId = ((await body(purchaseReturn)) as { returns: { id: string } }).returns.id;

  const confirmPurchase = await api(staffCookies, `/api/returns/${purchaseReturnId}/confirm`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(confirmPurchase.status === 200, `confirm purchase return: ${confirmPurchase.status}`);
  assert(stockAt(batch.id, outlet.id) === 14, "purchase return must de-stock the batch");

  const purchaseRefundRes = await api(staffCookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "out", partyType: "vendor", partyId: vendor.id, purchaseBillId: bill.id, amountPaise: 20 * 1500, mode: "bank", outletId: outlet.id },
  });
  assert(purchaseRefundRes.status === 200, `pay the bill: ${purchaseRefundRes.status}`);

  const purchaseRefundIn = await api(staffCookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "in", partyType: "vendor", partyId: vendor.id, returnId: purchaseReturnId, amountPaise: 4 * 1500, mode: "bank", outletId: outlet.id },
  });
  assert(purchaseRefundIn.status === 200, `purchase-return refund: ${purchaseRefundIn.status}`);

  const overPurchaseRefund = await api(staffCookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "in", partyType: "vendor", partyId: vendor.id, returnId: purchaseReturnId, amountPaise: 1, mode: "bank", outletId: outlet.id },
  });
  assert(overPurchaseRefund.status === 409, `purchase-return refund past cap must 409, got ${overPurchaseRefund.status}`);

  const shortDraft = await api(staffCookies, "/api/returns", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { returnType: "purchase", purchaseBillId: bill.id, items: [{ originalItemId: billLineId, quantity: 15 }] },
  });
  assert(shortDraft.status === 200, "oversized purchase return draft must be creatable");
  const shortReturnId = ((await body(shortDraft)) as { returns: { id: string } }).returns.id;
  const shortConfirm = await api(staffCookies, `/api/returns/${shortReturnId}/confirm`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(shortConfirm.status === 409 && ((await body(shortConfirm)) as Envelope).error?.reason === "insufficient_stock", `purchase return past available stock must 409 insufficient_stock, got ${shortConfirm.status}`);
  assert(stockAt(batch.id, outlet.id) === 14, "failed purchase return must move zero stock");
}

try {
  await scenario();
} catch (err) {
  failures.push(`smoke-returns scenario threw: ${String(err)}`);
} finally {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
}

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0], all: failures }, "smoke-returns FAILED");
  process.exit(1);
}
log.info("smoke-returns PASS");