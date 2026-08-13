import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";

process.env.NODE_ENV = "test";
const tmpPath = join("data", `smoke-catalog-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.AUTH_SECRET = "smoke-catalog-secret";
process.env.SUPERUSER_EMAIL = "admin@smoke.test";
process.env.SUPERUSER_PASSWORD = "admin-pass-123";

mkdirSync(dirname(tmpPath), { recursive: true });

const { logger } = await import("../lib/logger");
const log = logger.child({ module: "smoke-catalog" });
const failures: string[] = [];

const { db } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");
const { bootstrapAdmin } = await import("../lib/auth");
const { app } = await import("../app");
const { auditEvents } = await import("../db/schema/facts");
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
      body: JSON.stringify({ email: "admin@smoke.test", password: "admin-pass-123" }),
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

async function scenario(): Promise<void> {
  const cookies = await signIn();

  const publicRead = await api("", "/api/categories");
  assert(publicRead.status === 200, `public catalog read: expected 200, got ${publicRead.status}`);

  const noSession = await api("", "/api/inventory/stock-levels");
  assert(noSession.status === 401, `staff read without session: expected 401, got ${noSession.status}`);

  const health = await api(cookies, "/api/health");
  assert(health.status === 200, `health: expected 200, got ${health.status}`);

  const emptyLevels = await body(await api(cookies, "/api/inventory/stock-levels"));
  assert(Array.isArray(emptyLevels.data) && emptyLevels.data.length === 0, "empty DB must report zero stock_levels");
  assert(emptyLevels.pagination !== undefined, "stock-levels response missing pagination");

  const noKey = await api(cookies, "/api/categories", { method: "POST", body: { name: "X" } });
  assert(noKey.status === 400, `missing idempotency key: expected 400, got ${noKey.status}`);
  const noKeyErr = await body(noKey);
  assert(noKeyErr.error?.reason === "idempotency_key_required", "missing-key reason mismatch");

  const catKey = randomUUIDv7();
  const catRes = await api(cookies, "/api/categories", {
    method: "POST",
    idempotencyKey: catKey,
    body: { name: "Beverages" },
  });
  assert(catRes.status === 200, `create category: expected 200, got ${catRes.status}`);
  const cat = (await body(catRes)) as { id: string };
  assert(typeof cat.id === "string", "create category did not return id");
  assert(catRes.headers.get("idempotency-replayed") === null, "first run must not be a replay");

  const replay = await api(cookies, "/api/categories", {
    method: "POST",
    idempotencyKey: catKey,
    body: { name: "Beverages" },
  });
  assert(replay.status === 200, `replay: expected 200, got ${replay.status}`);
  assert(replay.headers.get("idempotency-replayed") === "true", "same-key replay must set Idempotency-Replayed");

  const mismatch = await api(cookies, "/api/categories", {
    method: "POST",
    idempotencyKey: catKey,
    body: { name: "Different" },
  });
  assert(mismatch.status === 409, `idempotency mismatch: expected 409, got ${mismatch.status}`);
  const mismatchErr = await body(mismatch);
  assert(mismatchErr.error?.reason === "idempotency_mismatch", "mismatch reason mismatch");

  const parentRes = await api(cookies, "/api/categories", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "Drinks", parentId: cat.id },
  });
  assert(parentRes.status === 200, `create subcategory: expected 200, got ${parentRes.status}`);
  const parent = (await body(parentRes)) as { id: string };

  const cycle = await api(cookies, `/api/categories/${cat.id}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { parentId: parent.id },
  });
  assert(cycle.status === 409, `category cycle: expected 409, got ${cycle.status}`);
  const cycleErr = await body(cycle);
  assert(cycleErr.error?.reason === "category_cycle", "category_cycle reason mismatch");

  const productKey = randomUUIDv7();
  const productRes = await api(cookies, "/api/products", {
    method: "POST",
    idempotencyKey: productKey,
    body: {
      categoryId: cat.id,
      name: "Cola Classic",
      hsnCode: "22021010",
      gstRatePct: 12,
      baseVariant: { name: "Cola Classic 500ml", sku: "COLA-500", costPricePaise: 2000, sellingPricePaise: 2400, mrpPaise: 2600 },
    },
  });
  assert(productRes.status === 200, `create product: expected 200, got ${productRes.status}`);
  const product = (await body(productRes)) as { product: { id: string; slug: string }; baseVariant: { id: string } };
  assert(product.product.slug === "cola-classic", `slug derivation: got ${product.product.slug}`);
  assert(typeof product.baseVariant.id === "string", "base variant missing from product response");

  const dupSlug = await api(cookies, "/api/products", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      name: "Cola Classic",
      baseVariant: { name: "Cola Classic 1L", sku: "COLA-1L", costPricePaise: 3000, sellingPricePaise: 3600, mrpPaise: 3900 },
    },
  });
  assert(dupSlug.status === 409, `duplicate slug: expected 409, got ${dupSlug.status}`);
  const dupSlugErr = await body(dupSlug);
  assert(dupSlugErr.error?.reason === "duplicate_slug", "duplicate_slug reason mismatch");

  const detail = await api(cookies, "/api/products/cola-classic");
  assert(detail.status === 200, `product detail: expected 200, got ${detail.status}`);
  const detailBody = (await body(detail)) as { variants: unknown[]; media: unknown[] };
  assert(detailBody.variants.length === 1, "product detail variants count");

  const variantRes = await api(cookies, "/api/variants", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      productId: product.product.id,
      name: "Cola Classic 1L",
      sku: "COLA-1L",
      costPricePaise: 3000,
      sellingPricePaise: 3600,
    },
  });
  assert(variantRes.status === 200, `create variant: expected 200, got ${variantRes.status}`);

  const dupSku = await api(cookies, "/api/variants", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      productId: product.product.id,
      name: "Cola Classic 2L",
      sku: "COLA-1L",
      costPricePaise: 5000,
      sellingPricePaise: 5800,
    },
  });
  assert(dupSku.status === 409, `duplicate sku: expected 409, got ${dupSku.status}`);
  const dupSkuErr = await body(dupSku);
  assert(dupSkuErr.error?.reason === "duplicate_sku", "duplicate_sku reason mismatch");

  const deact = await api(cookies, `/api/products/${product.product.id}/deactivate`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(deact.status === 200, `deactivate: expected 200, got ${deact.status}`);
  const deactBody = (await body(deact)) as { isActive: number };
  assert(deactBody.isActive === 0, "deactivated product still active");

  const batchRes = await api(cookies, "/api/inventory/batches", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { variantId: product.baseVariant.id, batchNumber: "B1", costPricePaise: 2000 },
  });
  assert(batchRes.status === 200, `create batch: expected 200, got ${batchRes.status}`);
  await body(batchRes);

  const dupBatch = await api(cookies, "/api/inventory/batches", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { variantId: product.baseVariant.id, batchNumber: "B1", costPricePaise: 2000 },
  });
  assert(dupBatch.status === 409, `duplicate batch: expected 409, got ${dupBatch.status}`);
  const dupBatchErr = await body(dupBatch);
  assert(dupBatchErr.error?.reason === "duplicate_batch", "duplicate_batch reason mismatch");

  const levels = await body(await api(cookies, `/api/inventory/stock-levels?variantId=${product.baseVariant.id}`));
  assert(levels.data?.length === 0, "a batch with no movements must not project a stock_level row");

  const variantsList = await body(await api(cookies, `/api/variants?productId=${product.product.id}`));
  assert(variantsList.data?.length === 2, "variants list count");

  const outletsRows = db.select().from(outlets).all().length;
  assert(outletsRows === 1, "bootstrap must create exactly one outlet");

  const auditCounts: Record<string, number> = {};
  for (const entityType of ["category", "product", "variant", "batch"] as const) {
    const n = db.select({ id: auditEvents.id }).from(auditEvents).where(eq(auditEvents.entityType, entityType)).all().length;
    auditCounts[entityType] = n;
  }
  assert(auditCounts.category! >= 2, `category audit rows: ${String(auditCounts.category)}`);
  assert(auditCounts.product! >= 1, `product audit rows: ${String(auditCounts.product)}`);
  assert(auditCounts.variant! >= 2, `variant audit rows: ${String(auditCounts.variant)}`);
  assert(auditCounts.batch! >= 1, `batch audit rows: ${String(auditCounts.batch)}`);
}

try {
  await scenario();
} catch (err) {
  failures.push(`smoke-catalog scenario threw: ${String(err)}`);
} finally {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
}

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0], all: failures }, "smoke-catalog FAILED");
  process.exit(1);
}
log.info("smoke-catalog PASS");
