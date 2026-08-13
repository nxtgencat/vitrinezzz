import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";

process.env.NODE_ENV = "test";
const tmpPath = join("data", `smoke-inventory-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.AUTH_SECRET = "smoke-inventory-secret";
process.env.SUPERUSER_EMAIL = "admin@inventory.test";
process.env.SUPERUSER_PASSWORD = "admin-pass-123";

mkdirSync(dirname(tmpPath), { recursive: true });

const { logger } = await import("../lib/logger");
const log = logger.child({ module: "smoke-inventory" });
const failures: string[] = [];

const { db } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");
const { bootstrapAdmin } = await import("../lib/auth");
const { app } = await import("../app");
const { stockLevels, stockMovements } = await import("../db/schema/inventory");
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

async function signIn(): Promise<string> {
  const res = await app.fetch(
    new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@inventory.test", password: "admin-pass-123" }),
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

function countMovements(sourceType: string): number {
  return db.select({ n: stockMovements.id }).from(stockMovements).where(eq(stockMovements.sourceType, sourceType)).all().length;
}

async function scenario(): Promise<void> {
  const cookies = await signIn();

  const outletA = db.select().from(outlets).where(eq(outlets.name, "Main Outlet")).get();
  assert(outletA !== undefined, "bootstrap outlet A missing");
  if (!outletA) return;
  const outletBId = randomUUIDv7();
  const now = Date.now();
  db.insert(outlets)
    .values({ id: outletBId, name: "Second Outlet", isActive: 1, createdAt: now, updatedAt: now })
    .run();

  const productRes = await api(cookies, "/api/products", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      name: "Transfer Soda",
      hsnCode: "22021010",
      gstRatePct: 12,
      baseVariant: { name: "Transfer Soda 500ml", sku: "TS-500", costPricePaise: 2000, sellingPricePaise: 2400 },
    },
  });
  assert(productRes.status === 200, `create product: ${productRes.status}`);
  const product = (await body(productRes)) as { product: { id: string }; baseVariant: { id: string } };
  const variantId = product.baseVariant.id;

  const batchOf = async (number: string): Promise<string> => {
    const res = await api(cookies, "/api/inventory/batches", {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: { variantId, batchNumber: number, costPricePaise: 2000 },
    });
    assert(res.status === 200, `create batch ${number}: ${res.status}`);
    return ((await body(res)) as { id: string }).id;
  };
  const b1 = await batchOf("TS-B1");
  const b2 = await batchOf("TS-B2");
  const b3 = await batchOf("TS-B3");

  const seed = await api(cookies, "/api/inventory/adjustments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      outletId: outletA.id,
      reason: "seed stock",
      items: [
        { variantId, batchId: b1, quantity: 10 },
        { variantId, batchId: b2, quantity: 5 },
        { variantId, batchId: b3, quantity: 7 },
      ],
    },
  });
  assert(seed.status === 200, `create seed adjustment: ${seed.status}`);
  const seedDoc = (await body(seed)) as { id: string; items: { unitValuePaise: number }[] };
  assert(seedDoc.items.every((i) => i.unitValuePaise === 2000), "unitValuePaise must be server-derived from batch cost");

  const seedConfirm = await api(cookies, `/api/inventory/adjustments/${seedDoc.id}/confirm`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(seedConfirm.status === 200, `confirm seed adjustment: ${seedConfirm.status}`);
  assert(stockAt(outletA.id, b1) === 10 && stockAt(outletA.id, b2) === 5 && stockAt(outletA.id, b3) === 7, "seed stock sums wrong");
  assert(countMovements("adjustment") === 3, "seed adjustment must write exactly 3 movements");

  const transfer = await api(cookies, "/api/inventory/transfers", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      fromOutletId: outletA.id,
      toOutletId: outletBId,
      items: [
        { variantId, batchId: b1, quantity: 4 },
        { variantId, batchId: b2, quantity: 3 },
        { variantId, batchId: b3, quantity: 2 },
      ],
    },
  });
  assert(transfer.status === 200, `create transfer: ${transfer.status}`);
  const transferDoc = (await body(transfer)) as { id: string; status: string; items: unknown[] };
  assert(transferDoc.status === "draft", "transfer must start as draft");
  assert(transferDoc.items.length === 3, "transfer must carry 3 lines");

  const sameOutlet = await api(cookies, "/api/inventory/transfers", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { fromOutletId: outletA.id, toOutletId: outletA.id, items: [{ variantId, batchId: b1, quantity: 1 }] },
  });
  assert(sameOutlet.status === 400, `from==to transfer must be 400, got ${sameOutlet.status}`);

  const detail = await api(cookies, `/api/inventory/transfers/${transferDoc.id}`);
  assert(detail.status === 200, `transfer detail: ${detail.status}`);
  const detailBody = (await body(detail)) as { items: unknown[] };
  assert(detailBody.items.length === 3, "transfer detail must include items");

  const confirm = await api(cookies, `/api/inventory/transfers/${transferDoc.id}/confirm`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(confirm.status === 200, `confirm transfer: ${confirm.status}`);
  const confirmed = (await body(confirm)) as { status: string };
  assert(confirmed.status === "confirmed", "transfer must become confirmed");
  assert(countMovements("transfer") === 6, "3-line transfer must write exactly 6 movements (3 out + 3 in)");
  assert(
    stockAt(outletA.id, b1) === 6 && stockAt(outletA.id, b2) === 2 && stockAt(outletA.id, b3) === 5,
    "source outlet stock after transfer",
  );
  assert(
    stockAt(outletBId, b1) === 4 && stockAt(outletBId, b2) === 3 && stockAt(outletBId, b3) === 2,
    "destination outlet stock after transfer",
  );

  const movementsBeforeReconfirm = countMovements("transfer");
  const reconfirm = await api(cookies, `/api/inventory/transfers/${transferDoc.id}/confirm`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(reconfirm.status === 409, `re-confirm must be 409, got ${reconfirm.status}`);
  assert(countMovements("transfer") === movementsBeforeReconfirm, "re-confirm must write zero movements");

  const editConfirmed = await api(cookies, `/api/inventory/transfers/${transferDoc.id}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { fromOutletId: outletA.id, toOutletId: outletBId, items: [{ variantId, batchId: b1, quantity: 1 }], version: 1 },
  });
  assert(editConfirmed.status === 409, `PUT on confirmed transfer must be 409, got ${editConfirmed.status}`);

  const short = await api(cookies, "/api/inventory/transfers", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      fromOutletId: outletA.id,
      toOutletId: outletBId,
      items: [{ variantId, batchId: b1, quantity: 100 }],
    },
  });
  assert(short.status === 200, `create short transfer: ${short.status}`);
  const shortDoc = (await body(short)) as { id: string };

  const movementsBeforeShort = countMovements("transfer");
  const shortConfirm = await api(cookies, `/api/inventory/transfers/${shortDoc.id}/confirm`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(shortConfirm.status === 409, `insufficient transfer confirm must be 409, got ${shortConfirm.status}`);
  const shortErr = (await body(shortConfirm)) as { error?: { reason?: string } };
  assert(shortErr.error?.reason === "insufficient_stock", "insufficient transfer reason mismatch");
  assert(countMovements("transfer") === movementsBeforeShort, "insufficient transfer must roll back to zero movements");
  assert(stockAt(outletA.id, b1) === 6, "insufficient transfer must not move any stock");

  const stale = await api(cookies, "/api/inventory/transfers", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { fromOutletId: outletA.id, toOutletId: outletBId, items: [{ variantId, batchId: b1, quantity: 1 }] },
  });
  const staleDoc = (await body(stale)) as { id: string; version: number };
  const stalePut = await api(cookies, `/api/inventory/transfers/${staleDoc.id}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { fromOutletId: outletA.id, toOutletId: outletBId, items: [{ variantId, batchId: b2, quantity: 2 }], version: 99 },
  });
  assert(stalePut.status === 409, `stale version PUT must be 409, got ${stalePut.status}`);
  const staleErr = (await body(stalePut)) as { error?: { reason?: string } };
  assert(staleErr.error?.reason === "stale_version", "stale_version reason mismatch");
  const goodPut = await api(cookies, `/api/inventory/transfers/${staleDoc.id}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { fromOutletId: outletA.id, toOutletId: outletBId, items: [{ variantId, batchId: b2, quantity: 2 }], version: 1 },
  });
  assert(goodPut.status === 200, `valid versioned PUT: ${goodPut.status}`);

  const voidDoc = await api(cookies, "/api/inventory/transfers", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { fromOutletId: outletA.id, toOutletId: outletBId, items: [{ variantId, batchId: b3, quantity: 1 }] },
  });
  const voidDocBody = (await body(voidDoc)) as { id: string };
  const movementsBeforeVoid = countMovements("transfer");
  const voidRes = await api(cookies, `/api/inventory/transfers/${voidDocBody.id}/void`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(voidRes.status === 200, `void draft transfer: ${voidRes.status}`);
  assert(countMovements("transfer") === movementsBeforeVoid, "void must write zero movements");
  const confirmAfterVoid = await api(cookies, `/api/inventory/transfers/${voidDocBody.id}/confirm`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(confirmAfterVoid.status === 409, `confirm after void must be 409, got ${confirmAfterVoid.status}`);

  const negativeAdjust = await api(cookies, "/api/inventory/adjustments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { outletId: outletA.id, reason: "damage", items: [{ variantId, batchId: b1, quantity: -2 }] },
  });
  assert(negativeAdjust.status === 200, `create negative adjustment: ${negativeAdjust.status}`);
  const negativeDoc = (await body(negativeAdjust)) as { id: string };
  const negConfirm = await api(cookies, `/api/inventory/adjustments/${negativeDoc.id}/confirm`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(negConfirm.status === 200, `confirm negative adjustment: ${negConfirm.status}`);
  assert(stockAt(outletA.id, b1) === 4, "negative adjustment must decrement stock");

  const overAdjust = await api(cookies, "/api/inventory/adjustments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { outletId: outletA.id, reason: "damage", items: [{ variantId, batchId: b2, quantity: -999 }] },
  });
  const overDoc = (await body(overAdjust)) as { id: string };
  const movementsBeforeOver = countMovements("adjustment");
  const overConfirm = await api(cookies, `/api/inventory/adjustments/${overDoc.id}/confirm`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(overConfirm.status === 409, `over-adjust must be 409, got ${overConfirm.status}`);
  assert(countMovements("adjustment") === movementsBeforeOver, "over-adjust must roll back to zero movements");
  assert(stockAt(outletA.id, b2) === 2, "over-adjust must not change stock");

  const zeroQty = await api(cookies, "/api/inventory/adjustments", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { outletId: outletA.id, reason: "noop", items: [{ variantId, batchId: b1, quantity: 0 }] },
  });
  assert(zeroQty.status === 400, `zero-quantity adjustment line must be 400, got ${zeroQty.status}`);

  const listRes = await api(cookies, "/api/inventory/transfers?status=confirmed");
  assert(listRes.status === 200, `transfer list: ${listRes.status}`);
  const listBody = (await body(listRes)) as { data: unknown[]; pagination: unknown };
  assert(listBody.data?.length === 1, "confirmed transfer list must contain exactly one row");
  assert(listBody.pagination !== undefined, "transfer list missing pagination");

  const adjustList = await api(cookies, "/api/inventory/adjustments?status=confirmed");
  assert(adjustList.status === 200, `adjustment list: ${adjustList.status}`);
  const adjustListBody = (await body(adjustList)) as { data: unknown[] };
  assert(adjustListBody.data?.length === 2, "confirmed adjustment list must contain 2 rows (seed + negative)");
}

try {
  await scenario();
} catch (err) {
  failures.push(`smoke-inventory scenario threw: ${String(err)}`);
} finally {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
}

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0], all: failures }, "smoke-inventory FAILED");
  process.exit(1);
}
log.info("smoke-inventory PASS");
