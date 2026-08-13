import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const tmpPath = join("data", `payments-test-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "payments-test-secret";

const { db } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");

let outletId: string;

beforeAll(async () => {
  mkdirSync("data", { recursive: true });
  applyMigrations(db);
  outletId = randomUUIDv7();
  const now = Date.now();
  db.$client
    .prepare("INSERT INTO outlets (id, name, isActive, createdAt, updatedAt) VALUES (?, ?, 1, ?, ?)")
    .run(outletId, "payments test outlet", now, now);
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
});

describe("R3-payments — concurrent over-payment (architecture.md §4.3/§4.4)", () => {
  test("two payments on one paisa of outstanding: exactly one 200 + one 409, one row survives", async () => {
    const raceDb = join("data", `payments-race-${randomUUIDv7()}.sqlite`);
    const customerId = randomUUIDv7();
    const orderId = randomUUIDv7();
    const invoiceId = randomUUIDv7();
    const now = Date.now();

    const seedDb = new Database(raceDb);
    seedDb.run("PRAGMA journal_mode = WAL;");
    seedDb.run("PRAGMA foreign_keys = ON;");
    const seed = await import("drizzle-orm/bun-sqlite").then((m) => m.drizzle(seedDb));
    applyMigrations(seed);
    seedDb.run("BEGIN IMMEDIATE");
    try {
      seedDb
        .prepare("INSERT INTO outlets (id, name, isActive, createdAt, updatedAt) VALUES (?, ?, 1, ?, ?)")
        .run(outletId, "payments race outlet", now, now);
      seedDb
        .prepare("INSERT INTO customers (id, name, phone, gstin, isActive, createdAt, updatedAt) VALUES (?, 'racer', NULL, NULL, 1, ?, ?)")
        .run(customerId, now, now);
      seedDb
        .prepare("INSERT INTO orders (id, orderNumber, orderType, customerId, outletId, status, totalPaise, version, createdAt, updatedAt) VALUES (?, ?, 'pos', ?, ?, 'confirmed', 1, 1, ?, ?)")
        .run(orderId, `R3-${orderId}`, customerId, outletId, now, now);
      seedDb
        .prepare(
          "INSERT INTO invoices (id, invoiceNumber, orderId, customerId, outletId, status, subtotalPaise, taxPaise, totalPaise, version, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 'issued', 1, 0, 1, 1, ?, ?)",
        )
        .run(invoiceId, `R3-INV-${invoiceId}`, orderId, customerId, outletId, now, now);
      seedDb.run("COMMIT");
    } catch (err) {
      seedDb.run("ROLLBACK");
      throw err;
    }
    seedDb.close();

    const fixture = join(import.meta.dir, "fixtures", "payment-worker.ts");
    const env = {
      ...process.env,
      DATABASE_PATH: raceDb,
      PAY_DB: raceDb,
      PAY_OUTLET: outletId,
      PAY_INVOICE: invoiceId,
      PAY_CUSTOMER: customerId,
    };
    const spawn = async (): Promise<number> => {
      const proc = Bun.spawn(["bun", "run", fixture], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
      return await proc.exited;
    };
    const [exitA, exitB] = await Promise.all([spawn(), spawn()]);
    expect([exitA, exitB].sort()).toEqual([0, 3]);

    const checkDb = new Database(raceDb);
    const rows = checkDb
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM payments WHERE status = 'confirmed' AND invoiceId = ?")
      .get(invoiceId)!;
    expect(rows.n).toBe(1);
    checkDb.close();

    rmSync(raceDb, { force: true });
    rmSync(`${raceDb}-wal`, { force: true });
    rmSync(`${raceDb}-shm`, { force: true });
  });
});

describe("R7-payments — webhook dedupe race (architecture.md §4.2)", () => {
  test("two webhooks with one gatewayEventId: exactly one confirmed, one replayed, one confirmed row", async () => {
    const raceDb = join("data", `webhook-race-${randomUUIDv7()}.sqlite`);
    const customerId = randomUUIDv7();
    const orderId = randomUUIDv7();
    const invoiceId = randomUUIDv7();
    const variantId = randomUUIDv7();
    const productId = randomUUIDv7();
    const batchId = randomUUIDv7();
    const now = Date.now();

    const seedDb = new Database(raceDb);
    seedDb.run("PRAGMA journal_mode = WAL;");
    seedDb.run("PRAGMA foreign_keys = ON;");
    const seed = await import("drizzle-orm/bun-sqlite").then((m) => m.drizzle(seedDb));
    applyMigrations(seed);
    seedDb.run("BEGIN IMMEDIATE");
    try {
      seedDb
        .prepare("INSERT INTO outlets (id, name, isActive, createdAt, updatedAt) VALUES (?, ?, 1, ?, ?)")
        .run(outletId, "webhook race outlet", now, now);
      seedDb
        .prepare("INSERT INTO customers (id, name, phone, gstin, isActive, createdAt, updatedAt) VALUES (?, 'webhooker', NULL, NULL, 1, ?, ?)")
        .run(customerId, now, now);
      seedDb
        .prepare("INSERT INTO products (id, name, slug, hsnCode, gstRatePct, isActive, createdAt, updatedAt) VALUES (?, ?, ?, '', 12, 1, ?, ?)")
        .run(productId, "webhook product", `wh-${productId}`, now, now);
      seedDb
        .prepare(
          "INSERT INTO variants (id, productId, name, sku, barcode, costPricePaise, sellingPricePaise, mrpPaise, isBase, isTaxable, isCustomerVisible, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, NULL, 100, 150, 150, 1, 1, 1, 1, ?, ?)",
        )
        .run(variantId, productId, "webhook variant", `WH-${randomUUIDv7()}`, now, now);
      seedDb
        .prepare("INSERT INTO batches (id, variantId, batchNumber, expiryDate, costPricePaise, isActive, createdAt) VALUES (?, ?, ?, NULL, 100, 1, ?)")
        .run(batchId, variantId, "WEBHOOK-RACE", now);
      seedDb
        .prepare("INSERT INTO stock_movements (id, variantId, outletId, batchId, delta, reason, sourceType, sourceId, createdAt) VALUES (?, ?, ?, ?, 1, 'initial', 'seed', NULL, ?)")
        .run(randomUUIDv7(), variantId, outletId, batchId, now);
      seedDb
        .prepare("INSERT INTO stock_levels (variantId, outletId, batchId, quantity, lastMovementId, updatedAt) VALUES (?, ?, ?, 1, ?, ?)")
        .run(variantId, outletId, batchId, randomUUIDv7(), now);
      seedDb
        .prepare("INSERT INTO orders (id, orderNumber, orderType, customerId, outletId, status, totalPaise, version, createdAt, updatedAt) VALUES (?, ?, 'storefront', ?, ?, 'pending', 168, 1, ?, ?)")
        .run(orderId, `R7-${orderId}`, customerId, outletId, now, now);
      seedDb
        .prepare(
          "INSERT INTO invoices (id, invoiceNumber, orderId, customerId, outletId, status, subtotalPaise, taxPaise, totalPaise, version, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 'draft', 150, 18, 168, 1, ?, ?)",
        )
        .run(invoiceId, `R7-INV-${invoiceId}`, orderId, customerId, outletId, now, now);
      seedDb
        .prepare(
          "INSERT INTO invoice_items (id, invoiceId, variantId, name, quantity, unitPricePaise, taxRatePct, taxAmountPaise, lineTotalPaise, isCustomItem, allocations) VALUES (?, ?, ?, 'webhook item', 1, 150, 12, 18, 168, 0, ?)",
        )
        .run(randomUUIDv7(), invoiceId, variantId, JSON.stringify([{ batchId, qty: 1 }]));
      seedDb
        .prepare(
          "INSERT INTO payments (id, paymentNumber, direction, partyType, partyId, invoiceId, outletId, amountPaise, mode, gateway, gatewayPaymentId, gatewayEventId, status, createdAt) VALUES (?, ?, 'in', 'customer', ?, ?, ?, 168, 'gateway', NULL, ?, NULL, 'pending', ?)",
        )
        .run(randomUUIDv7(), `R7-PY-${randomUUIDv7()}`, customerId, invoiceId, outletId, "webhook-ref-race", now);
      seedDb.run("COMMIT");
    } catch (err) {
      seedDb.run("ROLLBACK");
      throw err;
    }
    seedDb.close();

    const fixture = join(import.meta.dir, "fixtures", "webhook-worker.ts");
    const env = {
      ...process.env,
      DATABASE_PATH: raceDb,
      WEBHOOK_DB: raceDb,
      WEBHOOK_GATEWAY: "gateway",
      WEBHOOK_REF: "webhook-ref-race",
      WEBHOOK_EVENT: "race-event-1",
    };
    const spawn = async (): Promise<number> => {
      const proc = Bun.spawn(["bun", "run", fixture], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
      return await proc.exited;
    };
    const [exitA, exitB] = await Promise.all([spawn(), spawn()]);
    expect([exitA, exitB].sort()).toEqual([0, 2]);

    const checkDb = new Database(raceDb);
    const confirmed = checkDb
      .query<{ n: number }, [string, string]>(
        "SELECT count(*) AS n FROM payments WHERE gateway = ? AND gatewayEventId = ? AND status = 'confirmed'",
      )
      .get("gateway", "race-event-1")!;
    expect(confirmed.n).toBe(1);
    const issued = checkDb.query<{ n: number }, [string]>("SELECT count(*) AS n FROM invoices WHERE id = ? AND status = 'issued'").get(invoiceId)!;
    expect(issued.n).toBe(1);
    const orderStatus = checkDb.query<{ status: string }, [string]>("SELECT status FROM orders WHERE id = ?").get(orderId)!;
    expect(orderStatus.status).toBe("confirmed");
    checkDb.close();

    rmSync(raceDb, { force: true });
    rmSync(`${raceDb}-wal`, { force: true });
    rmSync(`${raceDb}-shm`, { force: true });
  });
});