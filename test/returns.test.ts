import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const tmpPath = join("data", `returns-test-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "returns-test-secret";

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
    .run(outletId, "returns test outlet", now, now);
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
});

describe("R4-returns — concurrent over-return (architecture.md §4.6)", () => {
  test("two confirms of the last returnable unit: exactly one 200 + one 409, one restock movement", async () => {
    const raceDb = join("data", `returns-race-${randomUUIDv7()}.sqlite`);
    const customerId = randomUUIDv7();
    const orderId = randomUUIDv7();
    const invoiceId = randomUUIDv7();
    const invoiceItemId = randomUUIDv7();
    const variantId = randomUUIDv7();
    const productId = randomUUIDv7();
    const batchId = randomUUIDv7();
    let returnIdA = "";
    let returnIdB = "";
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
        .run(outletId, "returns race outlet", now, now);
      seedDb
        .prepare("INSERT INTO customers (id, name, phone, gstin, isActive, createdAt, updatedAt) VALUES (?, 'returner', NULL, NULL, 1, ?, ?)")
        .run(customerId, now, now);
      seedDb
        .prepare("INSERT INTO products (id, name, slug, hsnCode, gstRatePct, isActive, createdAt, updatedAt) VALUES (?, ?, ?, '', 12, 1, ?, ?)")
        .run(productId, "returns product", `rt-${productId}`, now, now);
      seedDb
        .prepare(
          "INSERT INTO variants (id, productId, name, sku, barcode, costPricePaise, sellingPricePaise, mrpPaise, isBase, isTaxable, isCustomerVisible, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, NULL, 100, 150, 150, 1, 1, 1, 1, ?, ?)",
        )
        .run(variantId, productId, "returns variant", `RT-${randomUUIDv7()}`, now, now);
      seedDb
        .prepare("INSERT INTO batches (id, variantId, batchNumber, expiryDate, costPricePaise, isActive, createdAt) VALUES (?, ?, ?, NULL, 100, 1, ?)")
        .run(batchId, variantId, "RETURNS-RACE", now);
      seedDb
        .prepare("INSERT INTO stock_movements (id, variantId, outletId, batchId, delta, reason, sourceType, sourceId, createdAt) VALUES (?, ?, ?, ?, 1, 'initial', 'seed', NULL, ?)")
        .run(randomUUIDv7(), variantId, outletId, batchId, now);
      seedDb
        .prepare("INSERT INTO stock_levels (variantId, outletId, batchId, quantity, lastMovementId, updatedAt) VALUES (?, ?, ?, 1, ?, ?)")
        .run(variantId, outletId, batchId, randomUUIDv7(), now);
      seedDb
        .prepare("INSERT INTO orders (id, orderNumber, orderType, customerId, outletId, status, totalPaise, version, createdAt, updatedAt) VALUES (?, ?, 'storefront', ?, ?, 'confirmed', 168, 1, ?, ?)")
        .run(orderId, `R4-${orderId}`, customerId, outletId, now, now);
      seedDb
        .prepare(
          "INSERT INTO invoices (id, invoiceNumber, orderId, customerId, outletId, status, subtotalPaise, taxPaise, totalPaise, version, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 'issued', 150, 18, 168, 1, ?, ?)",
        )
        .run(invoiceId, `R4-INV-${invoiceId}`, orderId, customerId, outletId, now, now);
      seedDb
        .prepare(
          "INSERT INTO invoice_items (id, invoiceId, variantId, name, quantity, unitPricePaise, taxRatePct, taxAmountPaise, lineTotalPaise, isCustomItem, allocations) VALUES (?, ?, ?, 'returnable item', 1, 150, 12, 18, 168, 0, ?)",
        )
        .run(invoiceItemId, invoiceId, variantId, JSON.stringify([{ batchId, qty: 1 }]));
      for (const suffix of ["A", "B"]) {
        const returnId = randomUUIDv7();
        if (suffix === "A") returnIdA = returnId;
        else returnIdB = returnId;
        seedDb
          .prepare(
            "INSERT INTO returns (id, returnNumber, returnType, orderId, purchaseBillId, outletId, status, version, createdAt, updatedAt) VALUES (?, ?, 'sales', ?, NULL, ?, 'draft', 1, ?, ?)",
          )
          .run(returnId, `R4-RT-${suffix}`, orderId, outletId, now, now);
        seedDb
          .prepare(
            "INSERT INTO return_items (id, returnId, variantId, originalItemId, quantity, unitPricePaise, taxAmountPaise) VALUES (?, ?, ?, ?, 1, 150, 18)",
          )
          .run(randomUUIDv7(), returnId, variantId, invoiceItemId);
      }
      seedDb.run("COMMIT");
    } catch (err) {
      seedDb.run("ROLLBACK");
      throw err;
    }
    seedDb.close();

    const fixture = join(import.meta.dir, "fixtures", "return-worker.ts");
    const env = {
      ...process.env,
      DATABASE_PATH: raceDb,
      RETURN_DB: raceDb,
      RETURN_OUTLET: outletId,
    };
    const spawn = (returnId: string): Promise<number> => {
      const proc = Bun.spawn(["bun", "run", fixture], { cwd: process.cwd(), env: { ...env, RETURN_DRAFT: returnId }, stdout: "pipe", stderr: "pipe" });
      return proc.exited;
    };
    const [exitA, exitB] = await Promise.all([spawn(returnIdA), spawn(returnIdB)]);
    expect([exitA, exitB].sort()).toEqual([0, 3]);

    const checkDb = new Database(raceDb);
    const confirmed = checkDb.query<{ n: number }, []>("SELECT count(*) AS n FROM returns WHERE status = 'confirmed'").get()!;
    expect(confirmed.n).toBe(1);
    const moves = checkDb
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM stock_movements WHERE batchId = ? AND reason = 'return_in'")
      .get(batchId)!;
    expect(moves.n).toBe(1);
    const events = checkDb.query<{ n: number }, [string]>("SELECT count(*) AS n FROM order_events WHERE orderId = ? AND type = 'return.confirmed'").get(orderId)!;
    expect(events.n).toBe(1);
    checkDb.close();

    rmSync(raceDb, { force: true });
    rmSync(`${raceDb}-wal`, { force: true });
    rmSync(`${raceDb}-shm`, { force: true });
  });
});