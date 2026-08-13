import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq, sql } from "drizzle-orm";

process.env.NODE_ENV = "test";
const tmpPath = join("data", `verify-stock-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;

mkdirSync(dirname(tmpPath), { recursive: true });

const { logger } = await import("../lib/logger");
const log = logger.child({ module: "verify-stock" });
const failures: string[] = [];

const { db } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");
const { createBatch, writeMovement, sumStockAtBatch, sumStock } = await import("../services/stock");
const { stockLevels, stockMovements } = await import("../db/schema/inventory");
const { variants, products } = await import("../db/schema/catalog");
const { outlets } = await import("../db/schema/org");
type StaffActor = import("../services/rbac").StaffActor;
type Tx = import("../lib/db").Tx;

applyMigrations(db);

const tx = <T>(fn: (t: Tx) => T): T => db.transaction((t) => fn(t), { behavior: "immediate" });

const actor: StaffActor = {
  userId: "verify",
  staffProfileId: "verify-sp",
  outletId: "verify-outlet",
  roleId: "verify-role",
  roleScope: "global",
  capabilities: ["canManageInventory"],
};

function assert(cond: boolean, msg: string): void {
  if (!cond) failures.push(msg);
}

async function scenario(): Promise<void> {
  const now = Date.now();

  const outletId = randomUUIDv7();
  tx((t) => {
    t.insert(outlets).values({ id: outletId, name: "verify-stock outlet", isActive: 1, createdAt: now, updatedAt: now }).run();
  });

  const productId = randomUUIDv7();
  tx((t) => {
    t.insert(products)
      .values({ id: productId, name: "verify product", slug: "verify-product", hsnCode: "", gstRatePct: 0, isActive: 1, createdAt: now, updatedAt: now })
      .run();
    t.insert(variants)
      .values({
        id: randomUUIDv7(),
        productId,
        name: "verify variant",
        sku: "VFY-1",
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

  const variantId = db.select({ id: variants.id }).from(variants).where(eq(variants.sku, "VFY-1")).get()!.id;

  const b1 = tx((t) =>
    createBatch(t, actor, {
      variantId,
      batchNumber: "VFY-B1",
      expiryDate: now + 30 * 86400000,
      costPricePaise: 100,
    }),
  );
  const b2 = tx((t) =>
    createBatch(t, actor, {
      variantId,
      batchNumber: "VFY-B2",
      expiryDate: now + 60 * 86400000,
      costPricePaise: 110,
    }),
  );

  let t = now;
  const moves = [
    { batchId: b1.id, delta: 10 },
    { batchId: b1.id, delta: 5 },
    { batchId: b2.id, delta: 7 },
    { batchId: b1.id, delta: -3 },
  ] as const;
  const movementRows: { id: string; createdAt: number }[] = [];
  for (const m of moves) {
    t += 1;
    const id = tx((tx2) =>
      writeMovement(tx2, {
        variantId,
        outletId,
        batchId: m.batchId,
        delta: m.delta,
        reason: "purchase",
        sourceType: "purchase_bill",
        sourceId: randomUUIDv7(),
        createdAt: t,
      }),
    );
    movementRows.push({ id, createdAt: t });
  }

  const expected: Record<string, { qty: number; lastMovementId: string; updatedAt: number }> = {};
  let running: Record<string, number> = { [b1.id]: 0, [b2.id]: 0 };
  for (const [i, m] of moves.entries()) {
    running = { ...running, [m.batchId]: running[m.batchId]! + m.delta };
    expected[m.batchId] = { qty: running[m.batchId]!, lastMovementId: movementRows[i]!.id, updatedAt: movementRows[i]!.createdAt };
  }

  const live = db.select().from(stockLevels).all();
  const liveByBatch = new Map(live.map((r) => [r.batchId, r]));

  for (const [batchId, exp] of Object.entries(expected)) {
    const got = liveByBatch.get(batchId);
    assert(got !== undefined, `stock_levels missing row for batch ${batchId}`);
    if (!got) continue;
    assert(got.quantity === exp.qty, `batch ${batchId}: live quantity ${got.quantity} != replayed ${exp.qty}`);
    assert(got.lastMovementId === exp.lastMovementId, `batch ${batchId}: live lastMovementId ${got.lastMovementId} != replayed ${exp.lastMovementId}`);
    assert(got.updatedAt === exp.updatedAt, `batch ${batchId}: live updatedAt ${got.updatedAt} != replayed ${exp.updatedAt}`);
  }
  assert(liveByBatch.size === Object.keys(expected).length, "stock_levels has extra rows");

  const movementsSorted = db
    .select({ id: stockMovements.id })
    .from(stockMovements)
    .orderBy(sql`${stockMovements.createdAt} asc, ${stockMovements.id} asc`)
    .all();
  assert(movementsSorted.length === moves.length, "replay lost movements");

  const replayed: Record<string, number> = {};
  for (const m of movementsSorted) {
    const row = db.select().from(stockMovements).where(eq(stockMovements.id, m.id)).get()!;
    replayed[row.batchId] = (replayed[row.batchId] ?? 0) + row.delta;
  }
  for (const [batchId, exp] of Object.entries(expected)) {
    assert(replayed[batchId] === exp.qty, `batch ${batchId}: replay sum ${replayed[batchId]} != ${exp.qty}`);
  }
  for (const batch of [b1, b2]) {
    const perBatch = tx((t) => sumStockAtBatch(t, variantId, outletId, batch.id));
    assert(perBatch === expected[batch.id]!.qty, `sumStockAtBatch ${batch.id}: ${perBatch} != ${expected[batch.id]!.qty}`);
  }
  const total = tx((t) => sumStock(t, variantId, outletId));
  assert(total === 19, `sumStock: ${total} != 19`);

  const neverNegative = db.select().from(stockLevels).where(sql`${stockLevels.quantity} < 0`).all();
  assert(neverNegative.length === 0, "negative stock_levels.quantity found");

  const emptyRow = db.select().from(stockLevels).where(and(eq(stockLevels.variantId, "nope"), eq(stockLevels.outletId, "nope"))).all();
  assert(emptyRow.length === 0, "empty reads return stray rows");
}

try {
  await scenario();
} catch (err) {
  failures.push(`verify-stock scenario threw: ${String(err)}`);
} finally {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
}

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0], all: failures }, "verify-stock FAILED");
  process.exit(1);
}
log.info("verify-stock PASS");
