import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const tmpPath = join("data", `sales-test-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "sales-test-secret";

const { db } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");
const { drizzle } = await import("drizzle-orm/bun-sqlite");
const { products, variants } = await import("../db/schema/catalog");
const { outlets } = await import("../db/schema/org");

let outletId: string;

beforeAll(async () => {
  mkdirSync("data", { recursive: true });
  applyMigrations(db);
  const now = Date.now();
  outletId = randomUUIDv7();
  const productId = randomUUIDv7();
  db.transaction(
    (tx) => {
      tx.insert(outlets).values({ id: outletId, name: "sales test outlet", isActive: 1, createdAt: now, updatedAt: now }).run();
      tx.insert(products)
        .values({ id: productId, name: "sales test product", slug: "sales-test-product", hsnCode: "", gstRatePct: 12, isActive: 1, createdAt: now, updatedAt: now })
        .run();
      tx.insert(variants)
        .values({
          id: randomUUIDv7(),
          productId,
          name: "sales test variant",
          sku: `SL-${randomUUIDv7()}`,
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
    },
    { behavior: "immediate" },
  );
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
});

describe("R2-sales — last-unit POS race (architecture.md §4.3)", () => {
  test("two POS checkouts on one unit: exactly one 200 + one 409, final stock 0, one order survives", async () => {
    const raceDb = join("data", `sales-race-${randomUUIDv7()}.sqlite`);
    const raceBatchId = randomUUIDv7();
    const raceVariantId = randomUUIDv7();

    const seedDb = new Database(raceDb);
    seedDb.run("PRAGMA journal_mode = WAL;");
    seedDb.run("PRAGMA foreign_keys = ON;");
    const seed = drizzle(seedDb);
    applyMigrations(seed);
    const now = Date.now();
    const productId = randomUUIDv7();
    seedDb.run("BEGIN IMMEDIATE");
    try {
      seedDb.prepare("INSERT INTO outlets (id, name, isActive, createdAt, updatedAt) VALUES (?, ?, 1, ?, ?)").run(outletId, "race outlet", now, now);
      seedDb
        .prepare("INSERT INTO products (id, name, slug, hsnCode, gstRatePct, isActive, createdAt, updatedAt) VALUES (?, ?, ?, '', 12, 1, ?, ?)")
        .run(productId, "race product", `race-${productId}`, now, now);
      seedDb
        .prepare(
          "INSERT INTO variants (id, productId, name, sku, barcode, costPricePaise, sellingPricePaise, mrpPaise, isBase, isTaxable, isCustomerVisible, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, NULL, 100, 150, 150, 1, 1, 1, 1, ?, ?)",
        )
        .run(raceVariantId, productId, "race variant", `RV-${randomUUIDv7()}`, now, now);
      seedDb
        .prepare("INSERT INTO batches (id, variantId, batchNumber, expiryDate, costPricePaise, isActive, createdAt) VALUES (?, ?, ?, NULL, 100, 1, ?)")
        .run(raceBatchId, raceVariantId, "RACE-SALE", now);
      seedDb
        .prepare(
          "INSERT INTO stock_movements (id, variantId, outletId, batchId, delta, reason, sourceType, sourceId, createdAt) VALUES (?, ?, ?, ?, 1, 'initial', 'seed', NULL, ?)",
        )
        .run(randomUUIDv7(), raceVariantId, outletId, raceBatchId, now);
      seedDb
        .prepare(
          "INSERT INTO stock_levels (variantId, outletId, batchId, quantity, lastMovementId, updatedAt) VALUES (?, ?, ?, 1, ?, ?)",
        )
        .run(raceVariantId, outletId, raceBatchId, randomUUIDv7(), now);
      seedDb.run("COMMIT");
    } catch (err) {
      seedDb.run("ROLLBACK");
      throw err;
    }
    seedDb.close();

    const fixture = join(import.meta.dir, "fixtures", "pos-worker.ts");
    const env = {
      ...process.env,
      DATABASE_PATH: raceDb,
      POS_DB: raceDb,
      POS_OUTLET: outletId,
      POS_VARIANT: raceVariantId,
    };
    const spawn = async (): Promise<number> => {
      const proc = Bun.spawn(["bun", "run", fixture], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
      return await proc.exited;
    };
    const [exitA, exitB] = await Promise.all([spawn(), spawn()]);
    expect([exitA, exitB].sort()).toEqual([0, 3]);

    const checkDb = new Database(raceDb);
    checkDb.run("PRAGMA journal_mode = WAL;");
    const qty = checkDb.query<{ quantity: number }, [string]>("SELECT quantity FROM stock_levels WHERE batchId = ?").get(raceBatchId)!;
    expect(qty.quantity).toBe(0);
    const moves = checkDb
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM stock_movements WHERE batchId = ? AND reason = 'sale'")
      .get(raceBatchId)!;
    expect(moves.n).toBe(1);
    const orderCount = checkDb.query<{ n: number }, []>("SELECT count(*) AS n FROM orders").get()!;
    expect(orderCount.n).toBe(1);
    const invoiceCount = checkDb.query<{ n: number }, []>("SELECT count(*) AS n FROM invoices WHERE status = 'issued'").get()!;
    expect(invoiceCount.n).toBe(1);
    checkDb.close();

    rmSync(raceDb, { force: true });
    rmSync(`${raceDb}-wal`, { force: true });
    rmSync(`${raceDb}-shm`, { force: true });
  });
});
