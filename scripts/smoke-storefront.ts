import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";

process.env.NODE_ENV = "test";
const tmpPath = join("data", `smoke-storefront-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.AUTH_SECRET = "smoke-storefront-secret";
process.env.SUPERUSER_EMAIL = "admin@storefront.test";
process.env.SUPERUSER_PASSWORD = "admin-pass-123";

mkdirSync(dirname(tmpPath), { recursive: true });

const { logger } = await import("../lib/logger");
const log = logger.child({ module: "smoke-storefront" });
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
  data?: unknown[];
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

async function scenario(): Promise<void> {
  const staffCookies = await signIn("admin@storefront.test", "admin-pass-123");

  const outlet = db.select().from(outlets).where(eq(outlets.name, "Main Outlet")).get();
  assert(outlet !== undefined, "bootstrap outlet missing");
  if (!outlet) return;

  const hiddenProduct = await api(staffCookies, "/api/products", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      name: "Storefront Soda",
      gstRatePct: 12,
      baseVariant: { name: "Storefront Soda 500ml", sku: "SFS-500", costPricePaise: 1500, sellingPricePaise: 2400 },
    },
  });
  assert(hiddenProduct.status === 200, `create visible product: ${hiddenProduct.status}`);
  const visible = (await body(hiddenProduct)) as { product: { slug: string }; baseVariant: { id: string } };
  const visibleSlug = visible.product.slug;
  const variantId = visible.baseVariant.id;

  const hiddenRes = await api(staffCookies, "/api/products", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      name: "Staff Only Item",
      gstRatePct: 0,
      baseVariant: {
        name: "Staff Only 1l",
        sku: "SO-1L",
        costPricePaise: 1000,
        sellingPricePaise: 1800,
        isCustomerVisible: 0,
      },
    },
  });
  assert(hiddenRes.status === 200, `create hidden variant: ${hiddenRes.status}`);
  const hiddenSlug = ((await body(hiddenRes)) as { product: { slug: string } }).product.slug;

  const vendorRes = await api(staffCookies, "/api/vendors", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "Storefront Supplies", phone: "9876511111" },
  });
  const vendor = (await body(vendorRes)) as { id: string };

  const billRes = await api(staffCookies, "/api/purchase-bills", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      vendorId: vendor.id,
      outletId: outlet.id,
      items: [{ variantId, batchNumber: "SF-A", quantity: 10, unitCostPaise: 1500, taxRatePct: 0 }],
    },
  });
  const bill = (await body(billRes)) as { id: string };
  const issueBill = await api(staffCookies, `/api/purchase-bills/${bill.id}/issue`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(issueBill.status === 200, `issue bill: ${issueBill.status}`);
  const batch = db.select().from(batches).where(eq(batches.batchNumber, "SF-A")).get();
  assert(batch !== undefined, "seed batch missing");
  if (!batch) return;
  assert(
    (db.select({ qty: stockLevels.quantity }).from(stockLevels).where(and(eq(stockLevels.outletId, outlet.id), eq(stockLevels.batchId, batch.id))).get()?.qty ?? 0) === 10,
    "seed stock wrong",
  );

  const publicCatalog = await api(null, "/api/storefront/products");
  assert(publicCatalog.status === 200, `public catalog: ${publicCatalog.status}`);
  const catalogBody = (await body(publicCatalog)) as {
    data: {
      slug: string;
      variants: { id: string; isInStock: boolean; quantity?: number; stockQty?: number; sellingPricePaise?: number }[];
    }[];
  };
  const visibleProduct = catalogBody.data?.find((p) => p.slug === visibleSlug);
  assert(visibleProduct !== undefined, "public catalog must include the visible product");
  if (!visibleProduct) return;
  assert(visibleProduct.variants?.length === 1 && visibleProduct.variants[0]?.isInStock === true, "in-stock variant must report isInStock");
  assert(!catalogBody.data?.some((p) => p.slug === hiddenSlug), "public catalog must exclude hidden variants");
  for (const p of catalogBody.data ?? []) {
    for (const v of p.variants ?? []) {
      assert(v.quantity === undefined && v.stockQty === undefined, "public catalog must never expose quantity");
    }
  }

  const publicDetail = await api(null, `/api/storefront/products/${visibleSlug}`);
  assert(publicDetail.status === 200, `public product detail: ${publicDetail.status}`);
  const detailBody = (await body(publicDetail)) as { name: string; variants: unknown[] };
  assert(detailBody.name === "Storefront Soda" && detailBody.variants?.length === 1, "product detail shape wrong");
  const publicHidden = await api(null, `/api/storefront/products/${hiddenSlug}`);
  assert(publicHidden.status === 404, `hidden product detail must be 404, got ${publicHidden.status}`);

  const signUp = await app.fetch(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Shopper One", email: "shopper1@storefront.test", password: "shopper-pass-1" }),
    }),
  );
  assert(signUp.status === 200, `sign-up: ${signUp.status}`);
  const custCookies = await signIn("shopper1@storefront.test", "shopper-pass-1");

  const sessionRes = await api(custCookies, "/api/auth/get-session");
  const session = (await body(sessionRes)) as { user: { id: string } };
  const customerRow = db.select().from(customers).where(eq(customers.userId, session.user.id)).get();
  assert(customerRow !== undefined, "sign-up must auto-provision a customers row");
  if (!customerRow) return;
  const customerId = customerRow.id;

  const addrRes = await api(custCookies, "/api/storefront/addresses", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { label: "Home", line1: "1 Test Street", city: "Pune", state: "MH", pincode: "411001" },
  });
  assert(addrRes.status === 200, `create address: ${addrRes.status}`);
  const address = (await body(addrRes)) as { id: string };

  await api(custCookies, "/api/storefront/cart", {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { variantId, quantity: 2 },
  });
  const cartDel = await api(custCookies, `/api/storefront/cart/${variantId}`, {
    method: "DELETE",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(cartDel.status === 200, `cart delete: ${cartDel.status}`);
  const cartAfterDel = await api(custCookies, "/api/storefront/cart");
  const cartAfterDelBody = (await body(cartAfterDel)) as { data: unknown[] };
  assert(cartAfterDelBody.data?.length === 0, "cart delete must remove the line");

  const codCheckout = await api(custCookies, "/api/storefront/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { custAddressId: address.id, paymentMode: "cod" },
  });
  assert(codCheckout.status === 400, `empty-cart checkout must be 400, got ${codCheckout.status}`);

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
  const cod = (await body(codRes)) as {
    order: { id: string; status: string };
    invoice: { id: string; status: string; items: { id: string; name: string; quantity: number; unitPricePaise: number; taxAmountPaise: number; variantId: string | null }[] };
  };
  const codOrderId = cod.order.id;
  const codLineId = cod.invoice.items[0]!.id;

  const badReturn = await api(custCookies, "/api/storefront/returns", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { orderId: codOrderId, items: [{ originalItemId: randomUUIDv7(), quantity: 1 }] },
  });
  assert(badReturn.status === 404, `unknown original item must be 404, got ${badReturn.status}`);

  const dupReturn = await api(custCookies, "/api/storefront/returns", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      orderId: codOrderId,
      items: [
        { originalItemId: codLineId, quantity: 1 },
        { originalItemId: codLineId, quantity: 1 },
      ],
    },
  });
  assert(dupReturn.status === 400, `duplicate return lines must be 400, got ${dupReturn.status}`);

  const overReturn = await api(custCookies, "/api/storefront/returns", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { orderId: codOrderId, items: [{ originalItemId: codLineId, quantity: 3 }] },
  });
  assert(overReturn.status === 400, `over-quantity return must be 400, got ${overReturn.status}`);

  const goodReturn = await api(custCookies, "/api/storefront/returns", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { orderId: codOrderId, items: [{ originalItemId: codLineId, quantity: 2 }] },
  });
  assert(goodReturn.status === 200, `draft return: ${goodReturn.status}`);
  const draftReturn = (await body(goodReturn)) as {
    returns: { id: string; returnNumber: string; returnType: string; status: string; version: number };
    items: { originalItemId: string; quantity: number; unitPricePaise: number; taxAmountPaise: number; variantId: string }[];
  };
  assert(draftReturn.returns.returnNumber.startsWith("RT-"), "return number prefix wrong");
  assert(draftReturn.returns.returnType === "sales" && draftReturn.returns.status === "draft" && draftReturn.returns.version === 1, "return header wrong");
  assert(draftReturn.items.length === 1 && draftReturn.items[0]!.originalItemId === codLineId, "return line must reference the original");
  assert(
    draftReturn.items[0]!.quantity === 2 && draftReturn.items[0]!.unitPricePaise === cod.invoice.items[0]!.unitPricePaise,
    "return line must copy money from the original",
  );
  assert(draftReturn.items[0]!.variantId !== null, "return line must carry the variant id");
  assert(draftReturn.items[0]!.taxAmountPaise === cod.invoice.items[0]!.taxAmountPaise, "return line must copy tax from the original");
  assert(returnsCount() === 1, "exactly one return row after draft create");

  const secondReturn = await api(custCookies, "/api/storefront/returns", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { orderId: codOrderId, items: [{ originalItemId: codLineId, quantity: 1 }] },
  });
  assert(secondReturn.status === 200, "a second draft on the same invoice must be allowed at draft time (caps at confirm)");

  await api(custCookies, "/api/storefront/cart", {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { variantId, quantity: 1 },
  });
  const gatewayRes = await api(custCookies, "/api/storefront/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { custAddressId: address.id, paymentMode: "gateway" },
  });
  assert(gatewayRes.status === 200, `gateway checkout: ${gatewayRes.status}`);
  const gateway = (await body(gatewayRes)) as { order: { id: string } };
  const returnOnPending = await api(custCookies, "/api/storefront/returns", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { orderId: gateway.order.id, items: [{ originalItemId: codLineId, quantity: 1 }] },
  });
  assert(returnOnPending.status === 409, `return on a pending order must be 409, got ${returnOnPending.status}`);
  assert(((await body(returnOnPending)) as Envelope).error?.reason === "invalid_transition", "pending-order return reason mismatch");

  const customPos = await api(staffCookies, "/api/sales/pos/checkout", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      outletId: outlet.id,
      customerId,
      items: [
        { variantId, quantity: 1 },
        { isCustomItem: true, name: "Gift Wrap", quantity: 1, unitPricePaise: 9900 },
      ],
    },
  });
  assert(customPos.status === 200, `custom-line pos: ${customPos.status}`);
  const customPosBody = (await body(customPos)) as { order: { id: string; customerId: string | null }; invoice: { id: string } };
  const customInvoiceDetail = await api(staffCookies, `/api/invoices/${customPosBody.invoice.id}`);
  assert(customInvoiceDetail.status === 200, `custom pos invoice detail: ${customInvoiceDetail.status}`);
  const customInvoice = (await body(customInvoiceDetail)) as { items: { id: string; isCustomItem: number }[] };
  const customLineId = customInvoice.items.find((i) => i.isCustomItem === 1)!.id;
  const regularLineId = customInvoice.items.find((i) => i.isCustomItem === 0)!.id;
  const customPosOrderId = customPosBody.order.id;
  assert(customPosBody.order.customerId === customerId, "pos with customerId must attach the order to the customer");

  const customReturn = await api(custCookies, "/api/storefront/returns", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { orderId: customPosOrderId, items: [{ originalItemId: customLineId, quantity: 1 }] },
  });
  assert(customReturn.status === 400, `custom-line return must be 400, got ${customReturn.status}`);
  assert(((await body(customReturn)) as Envelope).error?.message === "custom line returns not supported", "custom-line rejection message mismatch");

  const regularReturn = await api(custCookies, "/api/storefront/returns", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { orderId: customPosOrderId, items: [{ originalItemId: regularLineId, quantity: 1 }] },
  });
  assert(regularReturn.status === 200, `regular-line return on owned pos order: ${regularReturn.status}`);
  assert(returnsCount() === 3, "draft returns must total exactly 3");
}

function returnsCount(): number {
  return db.select({ n: returns.id }).from(returns).all().length;
}

try {
  await scenario();
} catch (err) {
  failures.push(`smoke-storefront scenario threw: ${String(err)}`);
} finally {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
}

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0], all: failures }, "smoke-storefront FAILED");
  process.exit(1);
}
log.info("smoke-storefront PASS");