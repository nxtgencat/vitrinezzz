import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";

process.env.NODE_ENV = "test";
const tmpPath = join("data", `smoke-fulfillment-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.AUTH_SECRET = "smoke-fulfillment-secret";
process.env.SUPERUSER_EMAIL = "admin@fulfillment.test";
process.env.SUPERUSER_PASSWORD = "admin-pass-123";

mkdirSync(dirname(tmpPath), { recursive: true });

const { logger } = await import("../lib/logger");
const log = logger.child({ module: "smoke-fulfillment" });
const failures: string[] = [];

const { db } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");
const { bootstrapAdmin } = await import("../lib/auth");
const { app } = await import("../app");
const { customers } = await import("../db/schema/catalog");
const { orderEvents } = await import("../db/schema/facts");
const { shipments } = await import("../db/schema/orders");
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

function shipmentCount(): number {
  return db.select({ n: shipments.id }).from(shipments).all().length;
}

function eventsOf(orderId: string): string[] {
  return db
    .select({ type: orderEvents.type })
    .from(orderEvents)
    .where(eq(orderEvents.orderId, orderId))
    .orderBy(orderEvents.createdAt, orderEvents.id)
    .all()
    .map((e) => e.type);
}

async function scenario(): Promise<void> {
  const staffCookies = await signIn("admin@fulfillment.test", "admin-pass-123");

  const outlet = db.select().from(outlets).where(eq(outlets.name, "Main Outlet")).get();
  assert(outlet !== undefined, "bootstrap outlet missing");
  if (!outlet) return;

  const productRes = await api(staffCookies, "/api/products", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "Ship Soda", gstRatePct: 12, baseVariant: { name: "Ship Soda 500ml", sku: "SHP-500", costPricePaise: 1500, sellingPricePaise: 2400 } },
  });
  assert(productRes.status === 200, `create product: ${productRes.status}`);
  const variantId = ((await body(productRes)) as { baseVariant: { id: string } }).baseVariant.id;

  const vendorRes = await api(staffCookies, "/api/vendors", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "Ship Supplies", phone: "9876544444" },
  });
  const vendor = (await body(vendorRes)) as { id: string };

  const billRes = await api(staffCookies, "/api/purchase-bills", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      vendorId: vendor.id,
      outletId: outlet.id,
      items: [{ variantId, batchNumber: "SHP-A", quantity: 10, unitCostPaise: 1500, taxRatePct: 0 }],
    },
  });
  const bill = (await body(billRes)) as { id: string };
  const issueBill = await api(staffCookies, `/api/purchase-bills/${bill.id}/issue`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(issueBill.status === 200, `issue bill: ${issueBill.status}`);

  const signUp = await app.fetch(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ship Shopper", email: "ship@fulfillment.test", password: "ship-pass-1" }),
    }),
  );
  assert(signUp.status === 200, `sign-up: ${signUp.status}`);
  const custCookies = await signIn("ship@fulfillment.test", "ship-pass-1");
  const sessionRes = await api(custCookies, "/api/auth/get-session");
  const session = (await body(sessionRes)) as { user: { id: string } };
  const customerRow = db.select().from(customers).where(eq(customers.userId, session.user.id)).get();
  assert(customerRow !== undefined, "customer row missing");
  if (!customerRow) return;
  const customerId = customerRow.id;

  const addrRes = await api(custCookies, "/api/storefront/addresses", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { label: "Home", line1: "1 Ship Street", city: "Pune", state: "MH", pincode: "411001" },
  });
  assert(addrRes.status === 200, `create address: ${addrRes.status}`);
  const address = (await body(addrRes)) as { id: string };

  await api(custCookies, "/api/storefront/cart", {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { variantId, quantity: 2 },
  });
  const codRes = await api(custCookies, "/api/storefront/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { custAddressId: address.id, paymentMode: "cod" },
  });
  assert(codRes.status === 200, `cod checkout: ${codRes.status}`);
  const cod = (await body(codRes)) as { order: { id: string }; invoice: { id: string } };
  const orderId = cod.order.id;
  const invoiceId = cod.invoice.id;

  const before = shipmentCount();

  const noInvoice = await api(staffCookies, "/api/shipments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { invoiceId: randomUUIDv7(), carrier: "DHL" },
  });
  assert(noInvoice.status === 404, `unknown invoice must 404, got ${noInvoice.status}`);

  const createRes = await api(staffCookies, "/api/shipments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { invoiceId, carrier: "DHL", awbNumber: "AWB-1" },
  });
  assert(createRes.status === 200, `create shipment: ${createRes.status}`);
  const created = (await body(createRes)) as { id: string; shipmentNumber: string; status: string; version: number };
  const shipmentId = created.id;
  assert(created.shipmentNumber.startsWith("SH-"), "shipment number prefix wrong");
  assert(created.status === "created" && created.version === 1, "shipment must start created@1");
  assert(shipmentCount() === before + 1, "one shipment row");

  const badDispatch = await api(staffCookies, `/api/shipments/${shipmentId}/deliver`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(badDispatch.status === 409 && ((await body(badDispatch)) as Envelope).error?.reason === "invalid_transition", `deliver before dispatch must 409, got ${badDispatch.status}`);

  const staleEdit = await api(staffCookies, `/api/shipments/${shipmentId}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { carrier: "FedEx", version: 9 },
  });
  assert(staleEdit.status === 409 && ((await body(staleEdit)) as Envelope).error?.reason === "stale_version", `stale shipment edit must 409, got ${staleEdit.status}`);

  const editRes = await api(staffCookies, `/api/shipments/${shipmentId}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { carrier: "FedEx", awbNumber: "AWB-2", version: 1 },
  });
  assert(editRes.status === 200, `edit shipment: ${editRes.status}`);

  const dispatchRes = await api(staffCookies, `/api/shipments/${shipmentId}/dispatch`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(dispatchRes.status === 200, `dispatch: ${dispatchRes.status}`);

  const editAfterDispatch = await api(staffCookies, `/api/shipments/${shipmentId}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { carrier: "UPS", version: 2 },
  });
  assert(editAfterDispatch.status === 409, `edit after dispatch must 409, got ${editAfterDispatch.status}`);

  const deliverRes = await api(staffCookies, `/api/shipments/${shipmentId}/deliver`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(deliverRes.status === 200, `deliver: ${deliverRes.status}`);

  const reDeliver = await api(staffCookies, `/api/shipments/${shipmentId}/deliver`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(reDeliver.status === 409, `re-deliver must 409, got ${reDeliver.status}`);

  const events = eventsOf(orderId);
  assert(events.includes("shipment.dispatched") && events.includes("shipment.delivered"), "shipment events must be written on the order");

  const listRes = await api(staffCookies, "/api/shipments?status=delivered");
  const listBody = (await body(listRes)) as { data: unknown[]; pagination: { total: number } };
  assert(listBody.data?.length === 1 && listBody.pagination?.total === 1, "delivered shipment list wrong");

  const detailRes = await api(staffCookies, `/api/shipments/${shipmentId}`);
  const detail = (await body(detailRes)) as { status: string; invoiceNumber: string };
  assert(detail.status === "delivered" && typeof detail.invoiceNumber === "string" && detail.invoiceNumber.length > 0, "shipment detail shape wrong");

  const posRes = await api(staffCookies, "/api/sales/pos/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { outletId: outlet.id, customerId, items: [{ variantId, quantity: 1 }] },
  });
  assert(posRes.status === 200, `pos checkout: ${posRes.status}`);
  const pos = (await body(posRes)) as { invoice: { id: string } };
  const posShipment = await api(staffCookies, "/api/shipments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { invoiceId: pos.invoice.id, carrier: "BlueDart" },
  });
  assert(posShipment.status === 200, `shipment on pos invoice: ${posShipment.status}`);
}

try {
  await scenario();
} catch (err) {
  failures.push(`smoke-fulfillment scenario threw: ${String(err)}`);
} finally {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
}

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0], all: failures }, "smoke-fulfillment FAILED");
  process.exit(1);
}
log.info("smoke-fulfillment PASS");