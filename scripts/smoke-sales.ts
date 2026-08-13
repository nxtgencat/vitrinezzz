import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";

process.env.NODE_ENV = "test";
const tmpPath = join("data", `smoke-sales-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.AUTH_SECRET = "smoke-sales-secret";
process.env.SUPERUSER_EMAIL = "admin@sales.test";
process.env.SUPERUSER_PASSWORD = "admin-pass-123";

mkdirSync(dirname(tmpPath), { recursive: true });

const { logger } = await import("../lib/logger");
const log = logger.child({ module: "smoke-sales" });
const failures: string[] = [];

const { db } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");
const { bootstrapAdmin } = await import("../lib/auth");
const { app } = await import("../app");
const { batches, customers } = await import("../db/schema/catalog");
const { stockLevels, stockMovements } = await import("../db/schema/inventory");
const { orders } = await import("../db/schema/orders");
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
  const raw = await res.text();
  try {
    return JSON.parse(raw) as Envelope;
  } catch {
    failures.push(`non-JSON response status=${res.status} body=${raw.slice(0, 300)}`);
    return {};
  }
}

function stockAt(outletId: string, batchId: string): number {
  const row = db
    .select({ qty: stockLevels.quantity })
    .from(stockLevels)
    .where(and(eq(stockLevels.outletId, outletId), eq(stockLevels.batchId, batchId)))
    .get();
  return row?.qty ?? 0;
}

function countSaleMovements(sourceId: string): number {
  return db
    .select({ n: stockMovements.id })
    .from(stockMovements)
    .where(and(eq(stockMovements.sourceType, "sale"), eq(stockMovements.sourceId, sourceId)))
    .all().length;
}

function batchOf(variantId: string, batchNumber: string) {
  return db
    .select()
    .from(batches)
    .where(and(eq(batches.variantId, variantId), eq(batches.batchNumber, batchNumber)))
    .get();
}

function countOrders(): number {
  return db.select({ n: orders.id }).from(orders).all().length;
}

function countPayments(): number {
  return db.select({ n: payments.id }).from(payments).all().length;
}

async function scenario(): Promise<void> {
  const staffCookies = await signIn("admin@sales.test", "admin-pass-123");

  const outlet = db.select().from(outlets).where(eq(outlets.name, "Main Outlet")).get();
  assert(outlet !== undefined, "bootstrap outlet missing");
  if (!outlet) return;

  const productRes = await api(staffCookies, "/api/products", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      name: "Sales Soda",
      hsnCode: "22021010",
      gstRatePct: 12,
      baseVariant: { name: "Sales Soda 500ml", sku: "SS-500", costPricePaise: 1500, sellingPricePaise: 2400 },
    },
  });
  assert(productRes.status === 200, `create product: ${productRes.status}`);
  const product = (await body(productRes)) as { baseVariant: { id: string } };
  const variantId = product.baseVariant.id;

  const vendorRes = await api(staffCookies, "/api/vendors", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "Sales Supplies", phone: "9876500000" },
  });
  const vendor = (await body(vendorRes)) as { id: string };

  const preARes = await api(staffCookies, "/api/inventory/batches", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { variantId, batchNumber: "SB-A", costPricePaise: 1500, expiryDate: Date.now() + 86_400_000 },
  });
  assert(preARes.status === 200, `pre-create batch A: ${preARes.status}`);
  const preBRes = await api(staffCookies, "/api/inventory/batches", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { variantId, batchNumber: "SB-B", costPricePaise: 1600, expiryDate: Date.now() + 2 * 86_400_000 },
  });
  assert(preBRes.status === 200, `pre-create batch B: ${preBRes.status}`);
  const batchA = (await body(preARes)) as { id: string };
  const batchB = (await body(preBRes)) as { id: string };

  const billRes = await api(staffCookies, "/api/purchase-bills", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      vendorId: vendor.id,
      outletId: outlet.id,
      items: [
        { variantId, batchNumber: "SB-A", quantity: 10, unitCostPaise: 1500, taxRatePct: 0 },
        { variantId, batchNumber: "SB-B", quantity: 5, unitCostPaise: 1600, taxRatePct: 0 },
      ],
    },
  });
  assert(billRes.status === 200, `create bill: ${billRes.status}`);
  const bill = (await body(billRes)) as { id: string };
  const issueBill = await api(staffCookies, `/api/purchase-bills/${bill.id}/issue`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(issueBill.status === 200, `issue bill: ${issueBill.status}`);
  assert(batchOf(variantId, "SB-A")?.id === batchA.id && batchOf(variantId, "SB-B")?.id === batchB.id, "bill issue must reuse the pre-created batches");
  assert(stockAt(outlet.id, batchA.id) === 10 && stockAt(outlet.id, batchB.id) === 5, "seed stock wrong");

  const posRes = await api(staffCookies, "/api/sales/pos/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      outletId: outlet.id,
      items: [{ variantId, quantity: 2 }],
      charges: [{ name: "packing", amountPaise: 500 }],
    },
  });
  assert(posRes.status === 200, `pos checkout: ${posRes.status}`);
  const pos = (await body(posRes)) as { order: { id: string; status: string; totalPaise: number }; invoice: { id: string; status: string; subtotalPaise: number; taxPaise: number; totalPaise: number; outstandingPaise?: number } };
  assert(pos.order.status === "confirmed", "pos order must be confirmed");
  assert(pos.invoice.status === "issued", "pos invoice must be issued");
  assert(pos.invoice.subtotalPaise === 4800 && pos.invoice.taxPaise === 576 && pos.invoice.totalPaise === 5876, `pos money wrong: ${JSON.stringify(pos.invoice)}`);
  assert(pos.order.totalPaise === 5876, "order totalPaise must snapshot the invoice total");
  assert(stockAt(outlet.id, batchA.id) === 8 && stockAt(outlet.id, batchB.id) === 5, "pos must drop stock instantly (FIFO from batch A)");
  assert(countSaleMovements(pos.invoice.id) === 1, "pos must write one sale movement per allocated batch");

  const posDetail = await api(staffCookies, `/api/orders/${pos.order.id}`);
  assert(posDetail.status === 200, `pos order detail: ${posDetail.status}`);
  const posDetailBody = (await body(posDetail)) as { events: { type: string }[] };
  assert(
    posDetailBody.events?.map((e) => e.type).join(",") === "order.created,order.confirmed,invoice.issued",
    `pos timeline wrong: ${JSON.stringify(posDetailBody.events)}`,
  );

  const invDetail = await api(staffCookies, `/api/invoices/${pos.invoice.id}`);
  assert(invDetail.status === 200, `invoice detail: ${invDetail.status}`);
  const invDetailBody = (await body(invDetail)) as { items: unknown[]; charges: unknown[]; outstandingPaise: number };
  assert(invDetailBody.items?.length === 1 && invDetailBody.charges?.length === 1, "invoice detail must include lines and charges");
  assert(invDetailBody.outstandingPaise === 5876, "outstanding must equal total when unpaid");

  const movementsBefore = countSaleMovements(pos.invoice.id);
  const reissue = await api(staffCookies, `/api/invoices/${pos.invoice.id}/issue`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(reissue.status === 409, `re-issue must be 409, got ${reissue.status}`);
  assert(((await body(reissue)) as Envelope).error?.reason === "already_issued", "already_issued reason mismatch");
  assert(countSaleMovements(pos.invoice.id) === movementsBefore, "re-issue must write zero duplicate movements");

  const orderRes = await api(staffCookies, "/api/orders", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { orderType: "manual", outletId: outlet.id },
  });
  assert(orderRes.status === 200, `create draft order: ${orderRes.status}`);
  const draftOrder = (await body(orderRes)) as { id: string; status: string; version: number };
  assert(draftOrder.status === "draft" && draftOrder.version === 1, "order must start as draft v1");

  const confirmRes = await api(staffCookies, `/api/orders/${draftOrder.id}/confirm`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(confirmRes.status === 200, `confirm draft order: ${confirmRes.status}`);
  const confirmed = (await body(confirmRes)) as { status: string; invoice: { id: string; status: string; version: number; items: unknown[] } };
  assert(confirmed.status === "confirmed", "order must become confirmed");
  assert(confirmed.invoice.status === "draft" && confirmed.invoice.version === 1, "confirm must create an empty draft invoice");
  assert(confirmed.invoice.items.length === 0, "confirm-created invoice must start empty");
  const quoteInvoiceId = confirmed.invoice.id;
  assert(stockAt(outlet.id, batchA.id) === 8, "confirm must not touch stock");

  const priceInjected = await api(staffCookies, `/api/invoices/${quoteInvoiceId}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: {
      items: [{ variantId, quantity: 1, unitPricePaise: 1 }],
      version: 1,
    },
  });
  assert(priceInjected.status === 400, `client price on a regular line must be rejected, got ${priceInjected.status}`);

  const dupLines = await api(staffCookies, `/api/invoices/${quoteInvoiceId}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: {
      items: [
        { variantId, quantity: 1 },
        { variantId, quantity: 2 },
      ],
      version: 1,
    },
  });
  assert(dupLines.status === 400, `duplicate regular lines must be rejected, got ${dupLines.status}`);

  const stalePut = await api(staffCookies, `/api/invoices/${quoteInvoiceId}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { items: [{ variantId, quantity: 1 }], version: 99 },
  });
  assert(stalePut.status === 409, `stale PUT must be 409, got ${stalePut.status}`);
  assert(((await body(stalePut)) as Envelope).error?.reason === "stale_version", "stale_version reason mismatch");

  const putQuote = await api(staffCookies, `/api/invoices/${quoteInvoiceId}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: {
      items: [
        { variantId, quantity: 1 },
        { isCustomItem: true, name: "Basket", quantity: 1, unitPricePaise: 19900 },
      ],
      version: 1,
    },
  });
  assert(putQuote.status === 200, `fill quote invoice: ${putQuote.status}`);
  const quote = (await body(putQuote)) as { version: number; items: { isCustomItem: number; unitPricePaise: number; taxAmountPaise: number; lineTotalPaise: number }[]; subtotalPaise: number; taxPaise: number; totalPaise: number };
  assert(quote.version === 2, "PUT must bump invoice version to 2");
  assert(quote.items.length === 2, "quote must carry 2 lines");
  const regular = quote.items[0]!;
  assert(regular.isCustomItem === 0 && regular.unitPricePaise === 2400 && regular.taxAmountPaise === 288 && regular.lineTotalPaise === 2688, "regular line must re-derive price/tax");
  const custom = quote.items[1]!;
  assert(custom.isCustomItem === 1 && custom.unitPricePaise === 19900 && custom.taxAmountPaise === 0, "custom line must keep client price at zero tax");
  assert(quote.subtotalPaise === 22300 && quote.taxPaise === 288 && quote.totalPaise === 22588, `quote totals wrong: ${JSON.stringify(quote)}`);
  assert(stockAt(outlet.id, batchA.id) === 8, "draft quote must not touch stock");

  const issueQuote = await api(staffCookies, `/api/invoices/${quoteInvoiceId}/issue`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(issueQuote.status === 200, `issue quote: ${issueQuote.status}`);
  assert(countSaleMovements(quoteInvoiceId) === 1, "quote issue must write exactly one movement (regular line only)");
  assert(stockAt(outlet.id, batchA.id) === 7, "quote issue must drop stock for the regular line only");

  const voidIssued = await api(staffCookies, `/api/invoices/${quoteInvoiceId}/void`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(voidIssued.status === 409, `void on issued invoice must be 409, got ${voidIssued.status}`);

  const insufficient = await api(staffCookies, "/api/sales/pos/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { outletId: outlet.id, items: [{ variantId, quantity: 999 }] },
  });
  assert(insufficient.status === 409, `insufficient stock must be 409, got ${insufficient.status}`);
  assert(((await body(insufficient)) as Envelope).error?.reason === "insufficient_stock", "insufficient_stock reason mismatch");
  assert(countOrders() === 2, "failed pos checkout must roll back the whole document");
  assert(stockAt(outlet.id, batchA.id) === 7, "failed pos checkout must not touch stock");

  const voidableOrder = await api(staffCookies, "/api/orders", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { orderType: "manual", outletId: outlet.id },
  });
  const voidable = (await body(voidableOrder)) as { id: string };
  const cancelDraft = await api(staffCookies, `/api/orders/${voidable.id}/cancel`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(cancelDraft.status === 200, `staff cancel draft order: ${cancelDraft.status}`);

  const voidOrder2 = await api(staffCookies, "/api/orders", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { orderType: "manual", outletId: outlet.id },
  });
  const voidable2 = (await body(voidOrder2)) as { id: string };
  const confirm2 = await api(staffCookies, `/api/orders/${voidable2.id}/confirm`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  const confirmed2 = (await body(confirm2)) as { invoice: { id: string } };
  const voidRes = await api(staffCookies, `/api/invoices/${confirmed2.invoice.id}/void`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(voidRes.status === 200, `void draft invoice: ${voidRes.status}`);
  const issueVoided = await api(staffCookies, `/api/invoices/${confirmed2.invoice.id}/issue`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(issueVoided.status === 409, `issue on voided invoice must be 409, got ${issueVoided.status}`);
  assert(((await body(issueVoided)) as Envelope).error?.reason === "invalid_transition", "voided-issue reason mismatch");

  const signUp = await app.fetch(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "First Customer", email: "cust1@sales.test", password: "cust-pass-123" }),
    }),
  );
  assert(signUp.status === 200, `customer sign-up: ${signUp.status}`);

  const signUp2 = await app.fetch(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Second Customer", email: "cust2@sales.test", password: "cust-pass-123" }),
    }),
  );
  assert(signUp2.status === 200, `customer 2 sign-up: ${signUp2.status}`);

  const custCookies = await signIn("cust1@sales.test", "cust-pass-123");
  const cust2Cookies = await signIn("cust2@sales.test", "cust-pass-123");

  const sessionRes = await api(custCookies, "/api/auth/get-session");
  const session = (await body(sessionRes)) as { user: { id: string } };
  const customerRow = db.select().from(customers).where(eq(customers.userId, session.user.id)).get();
  assert(customerRow !== undefined, "sign-up must auto-provision a customers row");
  if (!customerRow) return;

  const cartPut = await api(custCookies, "/api/storefront/cart", {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { variantId, quantity: 3 },
  });
  assert(cartPut.status === 200, `cart upsert: ${cartPut.status}`);
  const cartPut2 = await api(custCookies, "/api/storefront/cart", {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { variantId, quantity: 5 },
  });
  assert(cartPut2.status === 200, `cart re-upsert: ${cartPut2.status}`);
  const cartList = await api(custCookies, "/api/storefront/cart");
  assert(cartList.status === 200, `cart list: ${cartList.status}`);
  const cartBody = (await body(cartList)) as { data: { quantity: number; unitPricePaise: number; lineTotalPaise: number }[] };
  assert(cartBody.data?.length === 1 && cartBody.data[0]?.quantity === 5, "cart upsert must replace quantity, not duplicate");
  assert(cartBody.data[0]?.unitPricePaise === 2400 && cartBody.data[0]?.lineTotalPaise === 12000, "cart line must carry current price");

  const wishAdd = await api(custCookies, "/api/storefront/wishlist", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { variantId },
  });
  assert(wishAdd.status === 200, `wishlist add: ${wishAdd.status}`);
  const wishList = await api(custCookies, "/api/storefront/wishlist");
  assert(wishList.status === 200, `wishlist list: ${wishList.status}`);
  const wishBody = (await body(wishList)) as { data: unknown[] };
  assert(wishBody.data?.length === 1, "wishlist must contain the variant");
  const wishDel = await api(custCookies, `/api/storefront/wishlist/${variantId}`, {
    method: "DELETE",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(wishDel.status === 200, `wishlist delete: ${wishDel.status}`);

  const addrRes = await api(custCookies, "/api/storefront/addresses", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { label: "Home", line1: "1 Main Road", city: "Bengaluru", state: "KA", pincode: "560001" },
  });
  assert(addrRes.status === 200, `create address: ${addrRes.status}`);
  const address = (await body(addrRes)) as { id: string };
  const addrList = await api(custCookies, "/api/storefront/addresses");
  const addrBody = (await body(addrList)) as { data: { id: string }[] };
  assert(addrBody.data?.length === 1, "address list must contain the address");
  const foreignAddr = await api(cust2Cookies, `/api/storefront/addresses/${address.id}`);
  assert(foreignAddr.status === 404, `another customer's address must be 404, got ${foreignAddr.status}`);

  const codCheckout = await api(custCookies, "/api/storefront/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { custAddressId: address.id, paymentMode: "cod" },
  });
  assert(codCheckout.status === 200, `cod checkout: ${codCheckout.status}`);
  const cod = (await body(codCheckout)) as {
    order: { id: string; status: string; totalPaise: number };
    invoice: { id: string; status: string; items: { unitPricePaise: number; quantity: number }[]; totalPaise: number };
    payment: unknown;
    checkoutReference: unknown;
  };
  assert(cod.order.status === "confirmed", "cod order must be confirmed");
  assert(cod.invoice.status === "issued", "cod invoice must be issued");
  assert(cod.invoice.totalPaise === 13440, `cod money wrong: ${cod.invoice.totalPaise}`);
  assert(cod.invoice.items?.[0]?.unitPricePaise === 2400 && cod.invoice.items?.[0]?.quantity === 5, "cod must re-price the cart from the variant");
  assert(cod.payment === null && cod.checkoutReference === null, "cod must not create a payment row");
  const cartAfterCod = await api(custCookies, "/api/storefront/cart");
  const cartAfterCodBody = (await body(cartAfterCod)) as { data: unknown[] };
  assert(cartAfterCodBody.data?.length === 0, "cod must clear the cart");
  assert(stockAt(outlet.id, batchA.id) === 2 && stockAt(outlet.id, batchB.id) === 5, "cod must drop stock FIFO");

  const codDetail = await api(custCookies, `/api/storefront/orders/${cod.order.id}`);
  assert(codDetail.status === 200, `customer order detail: ${codDetail.status}`);
  const codDetailBody = (await body(codDetail)) as { events: { type: string }[]; items: unknown[] };
  assert(
    codDetailBody.events?.map((e) => e.type).join(",") === "order.created,order.confirmed,invoice.issued",
    `cod timeline wrong: ${JSON.stringify(codDetailBody.events)}`,
  );
  assert(codDetailBody.items?.length === 1, "customer order detail must include invoice items");

  const foreignOrder = await api(cust2Cookies, `/api/storefront/orders/${cod.order.id}`);
  assert(foreignOrder.status === 404, `another customer's order must be 404, got ${foreignOrder.status}`);

  const priceChange = await api(staffCookies, `/api/variants/${variantId}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { sellingPricePaise: 2500 },
  });
  assert(priceChange.status === 200, `change variant price: ${priceChange.status}`);

  await api(custCookies, "/api/storefront/cart", {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { variantId, quantity: 2 },
  });
  const repriced = await api(custCookies, "/api/storefront/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { custAddressId: address.id, paymentMode: "cod" },
  });
  assert(repriced.status === 200, `repriced checkout: ${repriced.status}`);
  const repricedBody = (await body(repriced)) as { invoice: { items: { unitPricePaise: number; quantity: number }[]; totalPaise: number } };
  assert(repricedBody.invoice.items?.[0]?.unitPricePaise === 2500, "checkout must re-price from the current variant price");
  assert(repricedBody.invoice.totalPaise === 5600, `repriced total wrong: ${repricedBody.invoice.totalPaise}`);
  assert(stockAt(outlet.id, batchA.id) === 0 && stockAt(outlet.id, batchB.id) === 5, "repriced cod must keep consuming batch A first");

  await api(custCookies, "/api/storefront/cart", {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { variantId, quantity: 2 },
  });
  const gateway = await api(custCookies, "/api/storefront/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { custAddressId: address.id, paymentMode: "gateway" },
  });
  assert(gateway.status === 200, `gateway checkout: ${gateway.status}`);
  const gw = (await body(gateway)) as {
    order: { id: string; status: string };
    invoice: { id: string; status: string };
    payment: { status: string; mode: string; gatewayPaymentId: string; gateway: unknown; gatewayEventId: unknown };
    checkoutReference: string;
  };
  assert(gw.order.status === "pending", "gateway order must stay pending");
  assert(gw.invoice.status === "draft", "gateway invoice must stay draft");
  assert(gw.payment?.status === "pending" && gw.payment.mode === "gateway", "gateway payment row must be pending");
  assert(gw.payment.gateway === null && gw.payment.gatewayEventId === null, "pending payment must carry no gateway confirmation");
  assert(gw.checkoutReference === gw.payment.gatewayPaymentId, "checkoutReference must be the pending payment's gatewayPaymentId");
  assert(countPayments() === 1, "gateway checkout must create exactly one pending payment row");
  assert(stockAt(outlet.id, batchA.id) === 0 && stockAt(outlet.id, batchB.id) === 5, "gateway must not allocate stock");
  const cartAfterGw = await api(custCookies, "/api/storefront/cart");
  const cartAfterGwBody = (await body(cartAfterGw)) as { data: unknown[] };
  assert(cartAfterGwBody.data?.length === 1, "gateway must keep the cart");

  const gwCancel = await api(custCookies, `/api/storefront/orders/${gw.order.id}/cancel`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(gwCancel.status === 200, `customer cancel pending order: ${gwCancel.status}`);
  const gwCancelAgain = await api(custCookies, `/api/storefront/orders/${gw.order.id}/cancel`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(gwCancelAgain.status === 409, `re-cancel must be 409, got ${gwCancelAgain.status}`);
  const gwInvAfterCancel = await api(staffCookies, `/api/invoices/${gw.invoice.id}`);
  const gwInvAfterCancelBody = (await body(gwInvAfterCancel)) as { status: string };
  assert(gwInvAfterCancelBody.status === "void", "cancel must void the linked draft invoice");

  const addr2Res = await api(cust2Cookies, "/api/storefront/addresses", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { label: "Work", line1: "2 Park Road", city: "Bengaluru", state: "KA", pincode: "560002" },
  });
  assert(addr2Res.status === 200, `customer 2 address: ${addr2Res.status}`);
  const address2 = (await body(addr2Res)) as { id: string };
  await api(cust2Cookies, "/api/storefront/cart", {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { variantId, quantity: 1 },
  });
  for (let i = 0; i < 5; i++) {
    const burst = await api(cust2Cookies, "/api/storefront/checkout", {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: { custAddressId: address2.id, paymentMode: "gateway" },
    });
    assert(burst.status === 200, `rate-limit window checkout ${i}: ${burst.status}`);
  }
  assert(countPayments() === 6, "5 gateway checkouts must each create a pending payment row");
  const rateLimited = await api(cust2Cookies, "/api/storefront/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { custAddressId: address2.id, paymentMode: "gateway" },
  });
  assert(rateLimited.status === 429, `6th checkout in a minute must be 429, got ${rateLimited.status}`);
  assert(((await body(rateLimited)) as Envelope).error?.reason === "rate_limited", "rate_limited reason mismatch");

  await api(custCookies, "/api/storefront/cart", {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { variantId, quantity: 999 },
  });
  const noStock = await api(custCookies, "/api/storefront/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { custAddressId: address.id, paymentMode: "cod" },
  });
  assert(noStock.status === 409, `storefront insufficient stock must be 409, got ${noStock.status}`);
  assert(((await body(noStock)) as Envelope).error?.reason === "insufficient_stock", "storefront insufficient_stock reason mismatch");
  const cartAfterNoStock = await api(custCookies, "/api/storefront/cart");
  const cartAfterNoStockBody = (await body(cartAfterNoStock)) as { data: { quantity: number }[] };
  assert(cartAfterNoStockBody.data?.length === 1 && cartAfterNoStockBody.data[0]?.quantity === 999, "failed checkout must leave the cart untouched");
  assert(stockAt(outlet.id, batchB.id) === 5, "failed checkout must not touch stock");

  const ordersBefore = countOrders();
  await api(custCookies, `/api/storefront/cart/${variantId}`, { method: "DELETE", idempotencyKey: randomUUIDv7(), body: {} });
  const emptyCheckout = await api(custCookies, "/api/storefront/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { custAddressId: address.id, paymentMode: "cod" },
  });
  assert(emptyCheckout.status === 400, `empty-cart checkout must be 400, got ${emptyCheckout.status}`);
  assert(countOrders() === ordersBefore, "empty-cart checkout must create nothing");
}

try {
  await scenario();
} catch (err) {
  failures.push(`smoke-sales scenario threw: ${String(err)}`);
} finally {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
}

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0], all: failures }, "smoke-sales FAILED");
  process.exit(1);
}
log.info("smoke-sales PASS");