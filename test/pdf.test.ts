import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const tmpPath = join("data", `pdf-test-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "pdf-test-secret";
process.env.SUPERUSER_EMAIL = "admin@pdf.test";
process.env.SUPERUSER_PASSWORD = "admin-pass-123";
delete process.env.BUN_CHROME_PATH;

mkdirSync("data", { recursive: true });

const { db } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");
const { bootstrapAdmin } = await import("../lib/auth");
const { app } = await import("../app");
const { invoices } = await import("../db/schema/orders");
const { outlets } = await import("../db/schema/org");

let baseUrl: string;
let staffCookies: string;
let invoiceId: string;
let server: ReturnType<typeof Bun.serve> | null = null;

async function cookiesOf(res: Response): Promise<string> {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => c.length > 0)
    .join("; ");
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await app.fetch(
    new Request(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(res.status).toBe(200);
  return cookiesOf(res);
}

async function api(
  cookies: string,
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", cookie: cookies };
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  return app.fetch(
    new Request(`${baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    }),
  );
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeAll(async () => {
  applyMigrations(db);
  await bootstrapAdmin();
  server = Bun.serve({ port: 0, fetch: app.fetch });
  baseUrl = `http://127.0.0.1:${server.port}`;
  staffCookies = await signIn("admin@pdf.test", "admin-pass-123");

  const productRes = await api(staffCookies, "/api/products", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "PDF Soda", gstRatePct: 0, baseVariant: { name: "PDF Soda 500ml", sku: "PDF-1", costPricePaise: 1000, sellingPricePaise: 2000 } },
  });
  const product = await json<{ baseVariant: { id: string } }>(productRes);
  const variantId = product.baseVariant.id;

  const outletRow = db.select().from(outlets).limit(1).get();
  const vendorRes = await api(staffCookies, "/api/vendors", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "PDF Supplies", phone: "9876500000" },
  });
  const vendor = await json<{ id: string }>(vendorRes);
  const billRes = await api(staffCookies, "/api/purchase-bills", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { vendorId: vendor.id, outletId: outletRow!.id, items: [{ variantId, batchNumber: "PDF-A", quantity: 5, unitCostPaise: 1000, taxRatePct: 0 }] },
  });
  const bill = await json<{ id: string }>(billRes);
  const issueBill = await api(staffCookies, `/api/purchase-bills/${bill.id}/issue`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  expect(issueBill.status).toBe(200);

  const orderRes = await api(staffCookies, "/api/orders", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { orderType: "manual", outletId: outletRow!.id },
  });
  const order = await json<{ id: string }>(orderRes);
  const confirmRes = await api(staffCookies, `/api/orders/${order.id}/confirm`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  expect(confirmRes.status).toBe(200);
  const confirmed = await json<{ invoice: { id: string } }>(confirmRes);
  invoiceId = confirmed.invoice.id;
  const issueRes = await api(staffCookies, `/api/invoices/${invoiceId}/issue`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  expect(issueRes.status).toBe(200);
});

afterAll(() => {
  server?.stop(true);
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
});

describe("pdf — render without a renderer is non-fatal (architecture.md §4.9)", () => {
  test("parent call succeeds, pdfPath stays null, no file is written", async () => {
    const res = await api(staffCookies, `/api/invoices/${invoiceId}/render-pdf`, {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: { html: "<h1>Invoice</h1>" },
    });
    expect(res.status).toBe(200);
    const body = await json<{ pdfPath: string | null }>(res);
    expect(body.pdfPath).toBeNull();
    const row = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    expect(row?.pdfPath).toBeNull();
    if (row?.pdfPath) expect(existsSync(join("data", "storage", row.pdfPath))).toBe(false);
  });

  test("oversized html is rejected by the schema", async () => {
    const res = await api(staffCookies, `/api/invoices/${invoiceId}/render-pdf`, {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: { html: "x".repeat(256 * 1024 + 1) },
    });
    expect(res.status).toBe(400);
  });

  test("unknown invoice 404s", async () => {
    const res = await api(staffCookies, `/api/invoices/${randomUUIDv7()}/render-pdf`, {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: { html: "<p>x</p>" },
    });
    expect(res.status).toBe(404);
  });

  test("non-staff callers are refused", async () => {
    const signUp = await app.fetch(
      new Request(`${baseUrl}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "PDF Shopper", email: "shopper@pdf.test", password: "shopper-pass-1" }),
      }),
    );
    const custCookies = await cookiesOf(signUp);
    const res = await api(custCookies, `/api/invoices/${invoiceId}/render-pdf`, {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: { html: "<p>x</p>" },
    });
    expect(res.status).toBe(403);
  });
});