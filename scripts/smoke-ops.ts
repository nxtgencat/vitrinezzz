import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

process.env.NODE_ENV = "test";
const tmpPath = join("data", `smoke-ops-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.AUTH_SECRET = "smoke-ops-secret";
process.env.SUPERUSER_EMAIL = "admin@ops.test";
process.env.SUPERUSER_PASSWORD = "admin-pass-123";

mkdirSync(dirname(tmpPath), { recursive: true });

const { logger } = await import("../lib/logger");
const log = logger.child({ module: "smoke-ops" });
const failures: string[] = [];

const { db } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");
const { bootstrapAdmin } = await import("../lib/auth");
const { runNightlyBackup } = await import("../lib/backup");
const { checkStockProjection, runNightlyStockCheck } = await import("../lib/stock-check");
const { app } = await import("../app");
const { outlets, staffProfiles } = await import("../db/schema/org");
const { products, variants } = await import("../db/schema/catalog");
const { stockLevels } = await import("../db/schema/inventory");
const { createBatch, writeMovement } = await import("../services/stock");
import type { StaffActor } from "../services/rbac";

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

async function scenario(): Promise<void> {
  const adminCookies = await signIn("admin@ops.test", "admin-pass-123");
  const mainOutlet = db.select().from(outlets).where(eq(outlets.name, "Main Outlet")).get();
  assert(mainOutlet !== undefined, "bootstrap outlet missing");
  if (!mainOutlet) return;

  // --- health: never 500, real ledgerCounts ---
  const healthRes = await api(null, "/api/health");
  assert(healthRes.status === 200, `health: ${healthRes.status}`);
  const health = await body(healthRes);
  assert(health.status === "ok", `health status: ${String(health.status)}`);
  const counts = health.ledgerCounts as Record<string, number>;
  for (const key of ["stockMovements", "payments", "orderEvents", "auditEvents"]) {
    assert(typeof counts?.[key] === "number", `health ledgerCounts.${key} missing`);
  }

  // --- §2 org routes ---
  const settingsMissing = await api(adminCookies, "/api/settings");
  assert(settingsMissing.status === 404, `settings absent: ${settingsMissing.status}`);

  const settingsBare = await api(adminCookies, "/api/settings", { method: "PUT", idempotencyKey: randomUUIDv7(), body: {} });
  assert(settingsBare.status === 400, `settings first write without orgName: ${settingsBare.status}`);

  const settingsRes = await api(adminCookies, "/api/settings", {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { orgName: "Vitrine Ops", fiscalYearStartMonth: 4 },
  });
  assert(settingsRes.status === 200, `settings create: ${settingsRes.status}`);
  const settingsRow = await body(settingsRes);
  assert(settingsRow.currency === "INR" && settingsRow.timezone === "Asia/Kolkata", "settings defaults wrong");

  const outletsRes = await api(adminCookies, "/api/outlets");
  assert(outletsRes.status === 200, `outlets list: ${outletsRes.status}`);
  assert(((await body(outletsRes)).data as unknown[]).length === 1, "outlets list should have 1 bootstrap outlet");

  const outletRes = await api(adminCookies, "/api/outlets", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "Outlet B" },
  });
  assert(outletRes.status === 200, `outlet create: ${outletRes.status}`);
  const outletB = (await body(outletRes)) as { id: string };

  const setDefault = await api(adminCookies, "/api/settings", {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { defaultOutletId: outletB.id },
  });
  assert(setDefault.status === 200, `settings defaultOutletId: ${setDefault.status}`);

  const deactivateDefault = await api(adminCookies, `/api/outlets/${outletB.id}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { isActive: 0 },
  });
  assert(deactivateDefault.status === 409, `deactivate default outlet: ${deactivateDefault.status}`);

  const clearDefault = await api(adminCookies, "/api/settings", {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { defaultOutletId: null },
  });
  assert(clearDefault.status === 200, `settings clear defaultOutletId: ${clearDefault.status}`);

  const deactivateB = await api(adminCookies, `/api/outlets/${outletB.id}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { isActive: 0 },
  });
  assert(deactivateB.status === 200, `deactivate outlet B: ${deactivateB.status}`);
  const reactivateB = await api(adminCookies, `/api/outlets/${outletB.id}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { isActive: 1 },
  });
  assert(reactivateB.status === 200, `reactivate outlet B: ${reactivateB.status}`);

  const roleRes = await api(adminCookies, "/api/roles", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "Cashier", capabilities: ["canManageSales"], scope: "outlet", outletId: mainOutlet.id },
  });
  assert(roleRes.status === 200, `role create: ${roleRes.status}`);
  const cashierRole = (await body(roleRes)) as { id: string };

  const roleDup = await api(adminCookies, "/api/roles", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "Cashier", capabilities: ["canManageSales"], scope: "outlet", outletId: mainOutlet.id },
  });
  assert(roleDup.status === 409, `role duplicate: ${roleDup.status}`);

  const roleBadCap = await api(adminCookies, "/api/roles", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "Wizard", capabilities: ["canDoMagic"], scope: "global" },
  });
  assert(roleBadCap.status === 400, `role bad capability: ${roleBadCap.status}`);

  const roleNoOutlet = await api(adminCookies, "/api/roles", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "Floating", capabilities: ["canManageSales"], scope: "outlet" },
  });
  assert(roleNoOutlet.status === 400, `role outlet-scope without outletId: ${roleNoOutlet.status}`);

  const staffRes = await api(adminCookies, "/api/staff", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { email: "cashier@ops.test", password: "cashier-pass-1", name: "Cashier", outletId: mainOutlet.id, roleId: cashierRole.id },
  });
  assert(staffRes.status === 200, `staff create: ${staffRes.status}`);
  const cashierProfile = (await body(staffRes)) as { id: string };

  const staffDup = await api(adminCookies, "/api/staff", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { email: "cashier@ops.test", password: "cashier-pass-1", name: "Cashier", outletId: mainOutlet.id, roleId: cashierRole.id },
  });
  assert(staffDup.status === 409, `staff duplicate email: ${staffDup.status}`);

  const staffList = await api(adminCookies, "/api/staff");
  assert(staffList.status === 200, `staff list: ${staffList.status}`);
  assert(((await body(staffList)).data as unknown[]).length === 2, "staff list should have admin + cashier");

  const staffUpdate = await api(adminCookies, `/api/staff/${cashierProfile.id}`, {
    method: "PUT",
    idempotencyKey: randomUUIDv7(),
    body: { phone: "9876543210" },
  });
  assert(staffUpdate.status === 200, `staff update: ${staffUpdate.status}`);

  const cashierCookies = await signIn("cashier@ops.test", "cashier-pass-1");
  const cashierRoleList = await api(cashierCookies, "/api/roles");
  assert(cashierRoleList.status === 200, `cashier reads roles: ${cashierRoleList.status}`);
  const cashierCreateRole = await api(cashierCookies, "/api/roles", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: { name: "Nope", capabilities: ["canManageSales"], scope: "global" },
  });
  assert(cashierCreateRole.status === 403, `cashier creates role: ${cashierCreateRole.status}`);

  const adminProfile = db.select().from(staffProfiles).where(eq(staffProfiles.isProtected, 1)).get();
  assert(adminProfile !== undefined, "protected admin profile missing");
  if (adminProfile) {
    const deactivateAdminRes = await api(adminCookies, `/api/staff/${adminProfile.id}/deactivate`, {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: {},
    });
    assert(deactivateAdminRes.status === 409, `deactivate protected admin: ${deactivateAdminRes.status}`);
  }

  const deactivateCashier = await api(adminCookies, `/api/staff/${cashierProfile.id}/deactivate`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(deactivateCashier.status === 200, `deactivate cashier: ${deactivateCashier.status}`);

  const auditRes = await api(adminCookies, "/api/audit");
  assert(auditRes.status === 200, `audit list: ${auditRes.status}`);
  const auditRows = (await body(auditRes)).data as { entityType: string }[];
  assert(auditRows.length > 0, "audit list empty");
  assert(auditRows.some((r) => r.entityType === "staff"), "audit list missing staff rows");
  const auditFiltered = await api(adminCookies, "/api/audit?entityType=settings");
  assert(auditFiltered.status === 200, `audit filter: ${auditFiltered.status}`);
  assert(
    ((await body(auditFiltered)).data as { entityType: string }[]).every((r) => r.entityType === "settings"),
    "audit filter leaked other entity types",
  );

  // --- checkout rate limit: 5/min, 6th trips ---
  const signUp = await app.fetch(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ops Shopper", email: "shopper@ops.test", password: "shopper-pass-1" }),
    }),
  );
  assert(signUp.status === 200, `sign-up: ${signUp.status}`);
  const custCookies = await signIn("shopper@ops.test", "shopper-pass-1");
  const fakeAddress = randomUUIDv7();
  const checkoutStatuses: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const res = await api(custCookies, "/api/storefront/checkout", {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: { custAddressId: fakeAddress, paymentMode: "cod" },
    });
    checkoutStatuses.push(res.status);
  }
  assert(checkoutStatuses.slice(0, 5).every((s) => s !== 429), `checkout early trips: ${checkoutStatuses.join(",")}`);
  assert(checkoutStatuses[5] === 429, `checkout 6th should be 429: ${checkoutStatuses.join(",")}`);

  // --- auth rate limit: better-auth built-in under production env (spawned) ---
  const authLimitDb = join("data", `smoke-ops-authlimit-${randomUUIDv7()}.sqlite`);
  const workerEnv = { ...process.env } as Record<string, string>;
  delete workerEnv.TEST;
  workerEnv.NODE_ENV = "production";
  workerEnv.DATABASE_PATH = authLimitDb;
  workerEnv.AUTH_SECRET = "smoke-ops-auth-secret";
  workerEnv.SUPERUSER_EMAIL = "admin@ops.test";
  workerEnv.SUPERUSER_PASSWORD = "admin-pass-123";
  const worker = Bun.spawn(["bun", "run", "test/fixtures/auth-rate-limit-worker.ts"], {
    env: workerEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const workerCode = await worker.exited;
  if (workerCode !== 0) {
    failures.push(`auth rate limit worker exited ${workerCode}: ${await new Response(worker.stderr).text()}`);
  }
  rmSync(authLimitDb, { force: true });
  rmSync(`${authLimitDb}-wal`, { force: true });
  rmSync(`${authLimitDb}-shm`, { force: true });

  // --- nightly backup: real run, corrupt target ---
  const backupDir = join("data", `smoke-ops-backups-${randomUUIDv7()}`);
  process.env.BACKUP_DIR = backupDir;
  const backupMain = await runNightlyBackup();
  assert(backupMain !== null, "nightly backup failed");
  if (backupMain) {
    assert(await Bun.file(backupMain).exists(), "backup main file missing");
  }

  const corruptTarget = join("data", `smoke-ops-corrupt-${randomUUIDv7()}`);
  writeFileSync(corruptTarget, "not a directory");
  process.env.BACKUP_DIR = corruptTarget;
  const corruptResult = await runNightlyBackup();
  assert(corruptResult === null, "corrupt backup target should fail cleanly");
  const aliveRes = await api(null, "/api/health");
  assert(aliveRes.status === 200, `process not alive after corrupt backup: ${aliveRes.status}`);

  // --- stock projection: seed movements, backup, restore, replay-check ---
  const productId = randomUUIDv7();
  const now = Date.now();
  db.insert(products)
    .values({ id: productId, name: "Ops Product", slug: "ops-product", hsnCode: "", gstRatePct: 0, isActive: 1, createdAt: now, updatedAt: now })
    .run();
  db.insert(variants)
    .values({
      id: randomUUIDv7(),
      productId,
      name: "Ops Variant",
      sku: "OPS-1",
      barcode: null,
      costPricePaise: 100,
      sellingPricePaise: 150,
      mrpPaise: 150,
      isBase: 1,
      isTaxable: 1,
      isCustomerVisible: 1,
      isActive: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const variantId = db.select({ id: variants.id }).from(variants).where(eq(variants.sku, "OPS-1")).get()!.id;
  const actor: StaffActor = {
    userId: "smoke-ops",
    staffProfileId: "smoke-ops-sp",
    outletId: mainOutlet.id,
    roleId: "smoke-ops-role",
    roleScope: "global",
    capabilities: ["canManageInventory"],
  };
  const batch = db.transaction((t) => createBatch(t, actor, { variantId, batchNumber: "OPS-B1", expiryDate: now + 30 * 86400000, costPricePaise: 100 }), { behavior: "immediate" });
  db.transaction((t) => writeMovement(t, { variantId, outletId: mainOutlet.id, batchId: batch.id, delta: 7, reason: "purchase", sourceType: "purchase_bill", sourceId: randomUUIDv7(), createdAt: now }), { behavior: "immediate" });

  const beforeBackup = checkStockProjection(db);
  assert(beforeBackup.length === 0, `projection drift before backup: ${beforeBackup.join("; ")}`);

  const restoreDir = join("data", `smoke-ops-restore-${randomUUIDv7()}`);
  process.env.BACKUP_DIR = restoreDir;
  const restoreBackup = await runNightlyBackup();
  assert(restoreBackup !== null, "restore backup failed");
  if (restoreBackup) {
    const restoredPath = join("data", `smoke-ops-restored-${randomUUIDv7()}.sqlite`);
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = `${restoreBackup}${suffix}`;
      if (await Bun.file(src).exists()) {
        await Bun.write(`${restoredPath}${suffix}`, Bun.file(src));
      }
    }
    const restoredDb = new Database(restoredPath);
    const restored = drizzle(restoredDb);
    const restoredMismatches = checkStockProjection(restored);
    assert(restoredMismatches.length === 0, `restored backup drift: ${restoredMismatches.join("; ")}`);
    const moveCount = restoredDb.query("SELECT COUNT(*) AS n FROM stock_movements").get() as { n: number };
    assert(moveCount.n === 1, `restored backup lost movements: ${String(moveCount.n)}`);
    restoredDb.close();
    rmSync(restoredPath, { force: true });
    rmSync(`${restoredPath}-wal`, { force: true });
    rmSync(`${restoredPath}-shm`, { force: true });
  }

  // --- nightly verify-stock cron: fatal log on drift, never throws ---
  db.update(stockLevels).set({ quantity: 999 }).where(eq(stockLevels.variantId, variantId)).run();
  const drift = runNightlyStockCheck();
  assert(drift.length > 0, "nightly stock check missed the drift");
  const aliveAfterCheck = await api(null, "/api/health");
  assert(aliveAfterCheck.status === 200, `process not alive after drift check: ${aliveAfterCheck.status}`);

  // --- health degraded: a fact table gone reports 200 degraded, never 500 ---
  db.$client.query("DROP TABLE audit_events").run();
  const degradedRes = await api(null, "/api/health");
  assert(degradedRes.status === 200, `degraded health: ${degradedRes.status}`);
  const degraded = await body(degradedRes);
  assert(degraded.status === "degraded", `degraded status: ${String(degraded.status)}`);
  const degradedCounts = degraded.ledgerCounts as Record<string, number>;
  assert(typeof degradedCounts?.stockMovements === "number", "degraded health lost partial counts");
  assert(degradedCounts?.auditEvents === undefined, "degraded health reported the dropped table");
}

try {
  await scenario();
} catch (err) {
  failures.push(`smoke-ops scenario threw: ${String(err)}`);
} finally {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
  for (const pattern of ["data/smoke-ops-backups-*", "data/smoke-ops-restore-*", "data/smoke-ops-corrupt-*"]) {
    for (const f of new Bun.Glob(pattern).scanSync({ cwd: process.cwd(), absolute: true })) {
      rmSync(f, { recursive: true, force: true });
    }
  }
}

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0], all: failures }, "smoke-ops FAILED");
  process.exit(1);
}
log.info("smoke-ops PASS");