import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";

process.env.NODE_ENV = "test";
const tmpPath = join("data", `smoke-payments-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.AUTH_SECRET = "smoke-payments-secret";
process.env.SUPERUSER_EMAIL = "admin@payments.test";
process.env.SUPERUSER_PASSWORD = "admin-pass-123";
process.env.WEBHOOK_SECRET_GATEWAY = "smoke-gateway-secret";

mkdirSync(dirname(tmpPath), { recursive: true });

const { logger } = await import("../lib/logger");
const log = logger.child({ module: "smoke-payments" });
const failures: string[] = [];

const { db } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");
const { bootstrapAdmin } = await import("../lib/auth");
const { app } = await import("../app");
const { batches, customers } = await import("../db/schema/catalog");
const { stockLevels } = await import("../db/schema/inventory");
const { orderEvents } = await import("../db/schema/facts");
const { invoices, orders } = await import("../db/schema/orders");
const { payments } = await import("../db/schema/payments");
const { outlets } = await import("../db/schema/org");
const { webhookSignature } = await import("../lib/webhook");

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
  init: { method?: string; body?: unknown; idempotencyKey?: string; extraHeaders?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookies) headers["cookie"] = cookies;
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  if (init.extraHeaders) Object.assign(headers, init.extraHeaders);
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

function paymentCount(): number {
  return db.select({ n: payments.id }).from(payments).all().length;
}

function confirmedCount(): number {
  return db.select({ n: payments.id }).from(payments).where(eq(payments.status, "confirmed")).all().length;
}

function eventCount(orderId: string): number {
  return db.select({ n: orderEvents.id }).from(orderEvents).where(eq(orderEvents.orderId, orderId)).all().length;
}

function stockAt(batchId: string, outletId: string): number {
  return db.select({ qty: stockLevels.quantity }).from(stockLevels).where(and(eq(stockLevels.outletId, outletId), eq(stockLevels.batchId, batchId))).get()?.qty ?? 0;
}

async function scenario(): Promise<void> {
  const staffCookies = await signIn("admin@payments.test", "admin-pass-123");

  const outlet = db.select().from(outlets).where(eq(outlets.name, "Main Outlet")).get();
  assert(outlet !== undefined, "bootstrap outlet missing");
  if (!outlet) return;

  const productRes = await api(staffCookies, "/api/products", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "Pay Soda", gstRatePct: 12, baseVariant: { name: "Pay Soda 500ml", sku: "PAY-500", costPricePaise: 1500, sellingPricePaise: 2400 } },
  });
  assert(productRes.status === 200, `create product: ${productRes.status}`);
  const variantId = ((await body(productRes)) as { baseVariant: { id: string } }).baseVariant.id;

  const vendorRes = await api(staffCookies, "/api/vendors", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "Pay Supplies", phone: "9876522222" },
  });
  const vendor = (await body(vendorRes)) as { id: string };

  const billRes = await api(staffCookies, "/api/purchase-bills", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      vendorId: vendor.id,
      outletId: outlet.id,
      items: [{ variantId, batchNumber: "PAY-A", quantity: 10, unitCostPaise: 1500, taxRatePct: 0 }],
    },
  });
  const bill = (await body(billRes)) as { id: string };
  const issueBill = await api(staffCookies, `/api/purchase-bills/${bill.id}/issue`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(issueBill.status === 200, `issue bill: ${issueBill.status}`);
  const batch = db.select().from(batches).where(eq(batches.batchNumber, "PAY-A")).get();
  assert(batch !== undefined, "seed batch missing");
  if (!batch) return;

  const signUp = await app.fetch(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Paying Shopper", email: "paying@payments.test", password: "paying-pass-1" }),
    }),
  );
  assert(signUp.status === 200, `sign-up: ${signUp.status}`);
  const custCookies = await signIn("paying@payments.test", "paying-pass-1");
  const sessionRes = await api(custCookies, "/api/auth/get-session");
  const session = (await body(sessionRes)) as { user: { id: string } };
  const customerRow = db.select().from(customers).where(eq(customers.userId, session.user.id)).get();
  assert(customerRow !== undefined, "customer row missing");
  if (!customerRow) return;
  const customerId = customerRow.id;

  const addrRes = await api(custCookies, "/api/storefront/addresses", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { label: "Home", line1: "1 Pay Street", city: "Pune", state: "MH", pincode: "411001" },
  });
  assert(addrRes.status === 200, `create address: ${addrRes.status}`);
  const address = (await body(addrRes)) as { id: string };

  const posRes = await api(staffCookies, "/api/sales/pos/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { outletId: outlet.id, customerId, items: [{ variantId, quantity: 2 }] },
  });
  assert(posRes.status === 200, `pos checkout: ${posRes.status}`);
  const pos = (await body(posRes)) as { order: { id: string }; invoice: { id: string; totalPaise: number } };
  const total = pos.invoice.totalPaise;
  assert(total === 2 * 2688, `pos total wrong: ${total}`);

  const before = paymentCount();

  const overPay = await api(staffCookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "in", partyType: "customer", partyId: customerId, invoiceId: pos.invoice.id, amountPaise: total + 1, mode: "cash", outletId: outlet.id },
  });
  assert(overPay.status === 409 && ((await body(overPay)) as Envelope).error?.reason === "over_payment", `over-payment must 409 over_payment, got ${overPay.status}`);
  assert(paymentCount() === before, "over-payment must add zero rows");

  const partial = await api(staffCookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "in", partyType: "customer", partyId: customerId, invoiceId: pos.invoice.id, amountPaise: 1000, mode: "cash", outletId: outlet.id },
  });
  assert(partial.status === 200, `partial payment: ${partial.status}`);

  const overRefund = await api(staffCookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "out", partyType: "customer", partyId: customerId, invoiceId: pos.invoice.id, amountPaise: 1001, mode: "cash", outletId: outlet.id },
  });
  assert(overRefund.status === 409 && ((await body(overRefund)) as Envelope).error?.reason === "over_payment", `over-refund must 409 over_payment, got ${overRefund.status}`);

  const refund = await api(staffCookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "out", partyType: "customer", partyId: customerId, invoiceId: pos.invoice.id, amountPaise: 1000, mode: "cash", outletId: outlet.id },
  });
  assert(refund.status === 200, `refund: ${refund.status}`);

  const overRefund2 = await api(staffCookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "out", partyType: "customer", partyId: customerId, invoiceId: pos.invoice.id, amountPaise: 1, mode: "cash", outletId: outlet.id },
  });
  assert(overRefund2.status === 409, `refund past balance must 409, got ${overRefund2.status}`);

  const settle = await api(staffCookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "in", partyType: "customer", partyId: customerId, invoiceId: pos.invoice.id, amountPaise: total - 1000, mode: "upi", outletId: outlet.id },
  });
  assert(settle.status === 200, `settle: ${settle.status}`);

  const settleRest = await api(staffCookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "in", partyType: "customer", partyId: customerId, invoiceId: pos.invoice.id, amountPaise: 1000, mode: "bank", outletId: outlet.id },
  });
  assert(settleRest.status === 200, `settle refunded portion (refund reopens outstanding): ${settleRest.status}`);

  const settleOver = await api(staffCookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "in", partyType: "customer", partyId: customerId, invoiceId: pos.invoice.id, amountPaise: 1, mode: "bank", outletId: outlet.id },
  });
  assert(settleOver.status === 409, `payment past zero outstanding must 409, got ${settleOver.status}`);

  const gatewayMode = await api(staffCookies, "/api/payments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { direction: "in", partyType: "customer", partyId: customerId, invoiceId: pos.invoice.id, amountPaise: 1, mode: "gateway", outletId: outlet.id },
  });
  assert(gatewayMode.status === 400, `gateway mode on the staff route must 400, got ${gatewayMode.status}`);

  const payRowsBeforeWebhook = paymentCount();

  const unknownGateway = await app.fetch(
    new Request("http://localhost/api/webhooks/payments/unknown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "payment.confirmed", gatewayPaymentId: "x", gatewayEventId: "y" }),
    }),
  );
  assert(unknownGateway.status === 401 && ((await body(unknownGateway)) as Envelope).error?.message === "gateway_unknown", `unknown gateway must 401 gateway_unknown, got ${unknownGateway.status}`);
  assert(paymentCount() === payRowsBeforeWebhook, "unknown gateway must not touch the db");

  const missingSig = await app.fetch(
    new Request("http://localhost/api/webhooks/payments/gateway", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "payment.confirmed", gatewayPaymentId: "x", gatewayEventId: "y" }),
    }),
  );
  assert(missingSig.status === 401 && ((await body(missingSig)) as Envelope).error?.message === "bad_signature", `missing signature must 401 bad_signature, got ${missingSig.status}`);
  assert(paymentCount() === payRowsBeforeWebhook, "missing signature must not touch the db");

  const badSig = await app.fetch(
    new Request("http://localhost/api/webhooks/payments/gateway", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Webhook-Signature": "deadbeef" },
      body: JSON.stringify({ event: "payment.confirmed", gatewayPaymentId: "x", gatewayEventId: "y" }),
    }),
  );
  assert(badSig.status === 401 && ((await body(badSig)) as Envelope).error?.message === "bad_signature", `bad signature must 401 bad_signature, got ${badSig.status}`);
  assert(paymentCount() === payRowsBeforeWebhook, "bad signature must not touch the db");

  const badJson = await app.fetch(
    new Request("http://localhost/api/webhooks/payments/gateway", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Webhook-Signature": "deadbeef" },
      body: "not json",
    }),
  );
  assert(badJson.status === 401, `unparseable body with bad signature must still 401, got ${badJson.status}`);

  await api(custCookies, "/api/storefront/cart", {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { variantId, quantity: 1 },
  });
  const gwCheckout = await api(custCookies, "/api/storefront/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { custAddressId: address.id, paymentMode: "gateway" },
  });
  assert(gwCheckout.status === 200, `gateway checkout: ${gwCheckout.status}`);
  const gw = (await body(gwCheckout)) as { checkoutReference: string; order: { id: string }; payment: { amountPaise: number } };
  const checkoutRef = gw.checkoutReference;
  const gwOrderId = gw.order.id;
  const gwAmount = gw.payment.amountPaise;

  const unknownPayment = await app.fetch(
    new Request("http://localhost/api/webhooks/payments/gateway", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Webhook-Signature": webhookSignature(JSON.stringify({ event: "payment.confirmed", gatewayPaymentId: "nope", gatewayEventId: "e1" }), "smoke-gateway-secret") },
      body: JSON.stringify({ event: "payment.confirmed", gatewayPaymentId: "nope", gatewayEventId: "e1" }),
    }),
  );
  assert(unknownPayment.status === 404, `unknown gatewayPaymentId must 404, got ${unknownPayment.status}`);

  const moneyPayload = await app.fetch(
    new Request("http://localhost/api/webhooks/payments/gateway", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Webhook-Signature": webhookSignature(JSON.stringify({ event: "payment.confirmed", gatewayPaymentId: checkoutRef, gatewayEventId: "e2", amountPaise: 1 }), "smoke-gateway-secret") },
      body: JSON.stringify({ event: "payment.confirmed", gatewayPaymentId: checkoutRef, gatewayEventId: "e2", amountPaise: 1 }),
    }),
  );
  assert(moneyPayload.status === 400, `money field in webhook payload must 400 (strict schema), got ${moneyPayload.status}`);

  const stockBeforeConfirm = stockAt(batch.id, outlet.id);
  const eventsBeforeConfirm = eventCount(gwOrderId);

  const confirmBody = JSON.stringify({ event: "payment.confirmed", gatewayPaymentId: checkoutRef, gatewayEventId: "e3" });
  const confirmRes = await app.fetch(
    new Request("http://localhost/api/webhooks/payments/gateway", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Webhook-Signature": webhookSignature(confirmBody, "smoke-gateway-secret") },
      body: confirmBody,
    }),
  );
  assert(confirmRes.status === 200, `webhook confirm: ${confirmRes.status}`);
  const confirmed = (await body(confirmRes)) as { status: string; paymentId: string };
  assert(confirmed.status === "confirmed", `webhook must confirm, got ${confirmed.status}`);

  const order = db.select().from(orders).where(eq(orders.id, gwOrderId)).get();
  assert(order?.status === "confirmed", "order must be confirmed after webhook");
  const invoice = db.select().from(invoices).where(eq(invoices.orderId, gwOrderId)).get();
  assert(invoice?.status === "issued", "invoice must be issued after webhook");
  assert(stockAt(batch.id, outlet.id) === stockBeforeConfirm - 1, "stock must decrement on confirm");
  assert(eventCount(gwOrderId) === eventsBeforeConfirm + 3, "payment.confirmed+order.confirmed+invoice.issued events must be written");

  const replayBody = JSON.stringify({ event: "payment.confirmed", gatewayPaymentId: checkoutRef, gatewayEventId: "e3" });
  const replayRes = await app.fetch(
    new Request("http://localhost/api/webhooks/payments/gateway", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Webhook-Signature": webhookSignature(replayBody, "smoke-gateway-secret") },
      body: replayBody,
    }),
  );
  assert(replayRes.status === 200, `webhook replay: ${replayRes.status}`);
  assert(((await body(replayRes)) as { status: string }).status === "replayed", "replay must report replayed");
  assert(confirmedCount() === 5, `replay must add zero confirmed rows, got ${confirmedCount()}`);
  assert(eventCount(gwOrderId) === eventsBeforeConfirm + 3, "replay must add zero events");

  await api(custCookies, "/api/storefront/cart", {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { variantId, quantity: 1 },
  });
  const gw2 = await api(custCookies, "/api/storefront/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { custAddressId: address.id, paymentMode: "gateway" },
  });
  assert(gw2.status === 200, `second gateway checkout: ${gw2.status}`);
  const gw2Body = (await body(gw2)) as { checkoutReference: string; order: { id: string } };

  const cancelRes = await api(custCookies, `/api/storefront/orders/${gw2Body.order.id}/cancel`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(cancelRes.status === 200, `customer cancel: ${cancelRes.status}`);

  const cancelledConfirmBody = JSON.stringify({ event: "payment.confirmed", gatewayPaymentId: gw2Body.checkoutReference, gatewayEventId: "e4" });
  const cancelledConfirm = await app.fetch(
    new Request("http://localhost/api/webhooks/payments/gateway", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Webhook-Signature": webhookSignature(cancelledConfirmBody, "smoke-gateway-secret") },
      body: cancelledConfirmBody,
    }),
  );
  assert(cancelledConfirm.status === 200, `webhook on cancelled order: ${cancelledConfirm.status}`);
  const cancelledResult = (await body(cancelledConfirm)) as { status: string; refundPaymentId: string };
  assert(cancelledResult.status === "refunded", `cancelled-order arrival must auto-refund, got ${cancelledResult.status}`);
  const cancelledOrder = db.select().from(orders).where(eq(orders.id, gw2Body.order.id)).get();
  assert(cancelledOrder?.status === "cancelled", "cancelled order must stay cancelled");
  const gw2Invoice = db.select().from(invoices).where(eq(invoices.orderId, gw2Body.order.id)).get();
  assert(gw2Invoice !== undefined, "second invoice exists");
  const refundRow = db
    .select()
    .from(payments)
    .where(and(eq(payments.direction, "out"), eq(payments.invoiceId, gw2Invoice!.id)))
    .get();
  assert(refundRow !== undefined, "auto-refund out row must exist");
  assert(refundRow!.amountPaise === gwAmount, "auto-refund must equal the confirmed amount");
  assert(eventCount(gw2Body.order.id) >= 4, "cancelled-arrival events must be written");

  await api(custCookies, "/api/storefront/cart", {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { variantId, quantity: 2 },
  });
  const gw3 = await api(custCookies, "/api/storefront/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { custAddressId: address.id, paymentMode: "gateway" },
  });
  assert(gw3.status === 200, `third gateway checkout: ${gw3.status}`);
  const gw3Body = (await body(gw3)) as { checkoutReference: string; order: { id: string } };

  const deplete = await api(staffCookies, "/api/sales/pos/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { outletId: outlet.id, customerId, items: [{ variantId, quantity: 6 }] },
  });
  assert(deplete.status === 200, `depleting pos sale: ${deplete.status}`);

  const shortfallBody = JSON.stringify({ event: "payment.confirmed", gatewayPaymentId: gw3Body.checkoutReference, gatewayEventId: "e5" });
  const shortfallRes = await app.fetch(
    new Request("http://localhost/api/webhooks/payments/gateway", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Webhook-Signature": webhookSignature(shortfallBody, "smoke-gateway-secret") },
      body: shortfallBody,
    }),
  );
  assert(shortfallRes.status === 200, `short-stock webhook: ${shortfallRes.status}`);
  const shortfallResult = (await body(shortfallRes)) as { status: string };
  assert(shortfallResult.status === "refunded", `short-stock must compensate with refund, got ${shortfallResult.status}`);
  const gw3Order = db.select().from(orders).where(eq(orders.id, gw3Body.order.id)).get();
  assert(gw3Order?.status === "cancelled", "short-stock order must be cancelled");
  const gw3Invoice = db.select().from(invoices).where(eq(invoices.orderId, gw3Body.order.id)).get();
  assert(gw3Invoice?.status === "void", "short-stock invoice must be void");
  const gw3Refund = db
    .select()
    .from(payments)
    .where(and(eq(payments.direction, "out"), eq(payments.invoiceId, gw3Invoice!.id)))
    .get();
  assert(gw3Refund !== undefined, "short-stock auto-refund row must exist");
}

try {
  await scenario();
} catch (err) {
  failures.push(`smoke-payments scenario threw: ${String(err)}`);
} finally {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
}

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0], all: failures }, "smoke-payments FAILED");
  process.exit(1);
}
log.info("smoke-payments PASS");