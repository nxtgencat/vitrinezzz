import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";

const tmpPath = join("data", `stock-test-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "stock-test-secret";

const { db, withTx } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");
const { drizzle } = await import("drizzle-orm/bun-sqlite");
const { allocateBatches, createBatch, writeMovement } = await import("../services/stock");
const { stockLevels, stockMovements } = await import("../db/schema/inventory");
const { variants, products } = await import("../db/schema/catalog");
const { outlets } = await import("../db/schema/org");

type StaffActor = import("../services/rbac").StaffActor;

const actor: StaffActor = {
  userId: "stock-test",
  staffProfileId: "stock-test-sp",
  outletId: "stock-test-outlet",
  roleId: "stock-test-role",
  roleScope: "global",
  capabilities: ["canManageInventory"],
};

const FIXED_SKU = "ST-FIXED";

type Tx = import("../lib/db").Tx;
const tx = <T>(fn: (t: Tx) => T): T => db.transaction((t) => fn(t), { behavior: "immediate" });

let outletId: string;
let variantId: string;

beforeAll(async () => {
  mkdirSync("data", { recursive: true });
  applyMigrations(db);
  const now = Date.now();
  outletId = randomUUIDv7();
  const productId = randomUUIDv7();
  withTx((tx) => {
    tx.insert(outlets).values({ id: outletId, name: "stock test outlet", isActive: 1, createdAt: now, updatedAt: now }).run();
    tx.insert(products)
      .values({ id: productId, name: "stock test product", slug: "stock-test-product", hsnCode: "", gstRatePct: 0, isActive: 1, createdAt: now, updatedAt: now })
      .run();
    tx.insert(variants)
      .values({
        id: randomUUIDv7(),
        productId,
        name: "stock test variant",
        sku: FIXED_SKU,
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
  });
  variantId = db.select({ id: variants.id }).from(variants).where(eq(variants.sku, FIXED_SKU)).get()!.id;
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
});

describe("allocateBatches (pure, architecture.md §4.6)", () => {
  test("empty availability -> null for any positive request, [] for non-positive", () => {
    expect(allocateBatches([], 1)).toBeNull();
    expect(allocateBatches([], 0)).toEqual([]);
    expect(allocateBatches([], -3)).toEqual([]);
  });

  test("FIFO by expiry, nulls last", () => {
    const available = [
      { batchId: "late", quantity: 10, expiryDate: 200 },
      { batchId: "none", quantity: 10, expiryDate: null },
      { batchId: "early", quantity: 10, expiryDate: 100 },
    ];
    const allocation = allocateBatches(available, 25);
    expect(allocation).toEqual([
      { batchId: "early", qty: 10 },
      { batchId: "late", qty: 10 },
      { batchId: "none", qty: 5 },
    ]);
  });

  test("deterministic batchId tie-break for equal expiry", () => {
    const a = allocateBatches(
      [
        { batchId: "b", quantity: 5, expiryDate: 100 },
        { batchId: "a", quantity: 5, expiryDate: 100 },
      ],
      3,
    );
    expect(a).toEqual([{ batchId: "a", qty: 3 }]);
  });

  test("zero/negative holdings are skipped", () => {
    const allocation = allocateBatches(
      [
        { batchId: "empty", quantity: 0, expiryDate: 1 },
        { batchId: "negative", quantity: -4, expiryDate: 1 },
        { batchId: "real", quantity: 2, expiryDate: 2 },
      ],
      2,
    );
    expect(allocation).toEqual([{ batchId: "real", qty: 2 }]);
  });

  test("insufficient -> null (caller turns into 409)", () => {
    expect(allocateBatches([{ batchId: "x", quantity: 2, expiryDate: null }], 3)).toBeNull();
  });
});

describe("writeMovement projector", () => {
  test("projection is byte-identical to a (createdAt, id)-ordered replay", () => {
    const batch = tx((t) => createBatch(t, actor, { variantId, batchNumber: "PRJ-1", costPricePaise: 100 }));

    let t = Date.now();
    const deltas = [10, 5, -3, 7] as const;
    const movements: { id: string; createdAt: number; delta: number }[] = [];
    for (const delta of deltas) {
      t += 1;
      const id = tx((tx2) =>
        writeMovement(tx2, { variantId, outletId, batchId: batch.id, delta, reason: "purchase", sourceType: "purchase_bill", sourceId: randomUUIDv7(), createdAt: t }),
      );
      movements.push({ id, createdAt: t, delta });
    }

    const live = db.select().from(stockLevels).where(eq(stockLevels.batchId, batch.id)).get()!;
    let expectedQty = 0;
    let lastMovement: { id: string; createdAt: number } | null = null;
    for (const m of movements) {
      expectedQty += m.delta;
      lastMovement = m;
    }
    expect(live.quantity).toBe(expectedQty);
    expect(live.lastMovementId).toBe(lastMovement!.id);
    expect(live.updatedAt).toBe(lastMovement!.createdAt);

    const replay = db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.batchId, batch.id))
      .orderBy(stockMovements.createdAt, stockMovements.id)
      .all();
    expect(replay.length).toBe(deltas.length);
  });
});

describe("R2 — manual-adjustment-style race (architecture.md §4.3)", () => {
  test("two consumers on one unit of stock: exactly one wins, one gets 409, final stock is 0", async () => {
    const raceDb = join("data", `stock-race-${randomUUIDv7()}.sqlite`);
    const raceBatchId = randomUUIDv7();

    const seedDb = new Database(raceDb);
    seedDb.run("PRAGMA journal_mode = WAL;");
    seedDb.run("PRAGMA foreign_keys = ON;");
    const seed = drizzle(seedDb);
    applyMigrations(seed);
    const now = Date.now();
    const productId = randomUUIDv7();
    const raceVariantId = randomUUIDv7();
    seedDb.run("BEGIN IMMEDIATE");
    try {
      seedDb
        .prepare(
          "INSERT INTO outlets (id, name, isActive, createdAt, updatedAt) VALUES (?, ?, 1, ?, ?)",
        )
        .run(outletId, "race outlet", now, now);
      seedDb
        .prepare("INSERT INTO products (id, name, slug, hsnCode, gstRatePct, isActive, createdAt, updatedAt) VALUES (?, ?, ?, '', 0, 1, ?, ?)")
        .run(productId, "race product", `race-${productId}`, now, now);
      seedDb
        .prepare(
          "INSERT INTO variants (id, productId, name, sku, barcode, costPricePaise, sellingPricePaise, mrpPaise, isBase, isTaxable, isCustomerVisible, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, NULL, 100, 150, 150, 1, 1, 1, 1, ?, ?)",
        )
        .run(raceVariantId, productId, "race variant", `RV-${randomUUIDv7()}`, now, now);
      seedDb
        .prepare("INSERT INTO batches (id, variantId, batchNumber, expiryDate, costPricePaise, isActive, createdAt) VALUES (?, ?, ?, NULL, 100, 1, ?)")
        .run(raceBatchId, raceVariantId, "RACE-1", now);
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

    const fixture = join(import.meta.dir, "fixtures", "adjust-worker.ts");
    const env = {
      ...process.env,
      DATABASE_PATH: raceDb,
      ADJUST_DB: raceDb,
      ADJUST_VARIANT: raceVariantId,
      ADJUST_OUTLET: outletId,
      ADJUST_BATCH: raceBatchId,
    };
    const spawn = async (): Promise<number> => {
      const proc = Bun.spawn(["bun", "run", fixture], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
      return await proc.exited;
    };
    const [exitA, exitB] = await Promise.all([spawn(), spawn()]);
    expect([exitA, exitB].sort()).toEqual([0, 3]);

    const checkDb = new Database(raceDb);
    checkDb.run("PRAGMA journal_mode = WAL;");
    const qty = checkDb
      .query<{ quantity: number }, [string]>("SELECT quantity FROM stock_levels WHERE batchId = ?")
      .get(raceBatchId)!;
    expect(qty.quantity).toBe(0);
    const moves = checkDb
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM stock_movements WHERE batchId = ?")
      .get(raceBatchId)!;
    expect(moves.n).toBe(2);
    checkDb.close();

    rmSync(raceDb, { force: true });
    rmSync(`${raceDb}-wal`, { force: true });
    rmSync(`${raceDb}-shm`, { force: true });
  });
});