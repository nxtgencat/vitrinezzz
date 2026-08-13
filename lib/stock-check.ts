import { eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { stockLevels, stockMovements } from "../db/schema/inventory";
import { db } from "./db";
import { logger } from "./logger";

type StockProjectionDb = BunSQLiteDatabase<Record<string, never>>;

/**
 * The one projection check (`I1`): independently re-sums `stock_movements`
 * ordered `(createdAt, id)` and asserts the result is byte-identical to
 * `stock_levels` — quantity, `lastMovementId`, `updatedAt` — with no negative
 * quantity and no stray rows (`audit.md` §2 row 2). Returns the mismatched
 * keys, empty when the projection is consistent. Works against any drizzle
 * instance, so it doubles as the restore verification on a recovered backup
 * file (`audit.md` §6).
 */
export function checkStockProjection(target: StockProjectionDb): string[] {
  const movements = target
    .select({ id: stockMovements.id })
    .from(stockMovements)
    .orderBy(sql`${stockMovements.createdAt} asc, ${stockMovements.id} asc`)
    .all();
  const replayed = new Map<string, { qty: number; lastMovementId: string; updatedAt: number }>();
  for (const m of movements) {
    const row = target.select().from(stockMovements).where(eq(stockMovements.id, m.id)).get();
    if (!row) continue;
    const key = `${row.variantId}|${row.outletId}|${row.batchId}`;
    const cur = replayed.get(key) ?? { qty: 0, lastMovementId: "", updatedAt: 0 };
    replayed.set(key, { qty: cur.qty + row.delta, lastMovementId: row.id, updatedAt: row.createdAt });
  }
  const live = target.select().from(stockLevels).all();
  const mismatches: string[] = [];
  const liveByKey = new Map(live.map((r) => [`${r.variantId}|${r.outletId}|${r.batchId}`, r]));
  for (const [key, exp] of replayed) {
    const got = liveByKey.get(key);
    if (!got) {
      mismatches.push(`${key}: missing stock_levels row (replayed ${exp.qty})`);
      continue;
    }
    if (got.quantity !== exp.qty) mismatches.push(`${key}: quantity ${got.quantity} != replayed ${exp.qty}`);
    if (got.lastMovementId !== exp.lastMovementId) mismatches.push(`${key}: lastMovementId mismatch`);
    if (got.updatedAt !== exp.updatedAt) mismatches.push(`${key}: updatedAt mismatch`);
    if (got.quantity < 0) mismatches.push(`${key}: negative quantity ${got.quantity}`);
  }
  for (const r of live) {
    const key = `${r.variantId}|${r.outletId}|${r.batchId}`;
    if (!replayed.has(key)) mismatches.push(`${key}: stray stock_levels row (quantity ${r.quantity})`);
  }
  return mismatches;
}

/**
 * The nightly verify-stock cron body (`architecture.md` §4.17, `audit.md` §6):
 * run the projection check against the live DB; on any drift, log at `fatal`
 * level with the specific mismatched keys — the signal to page on. Never
 * throws: a failed check must not affect the running process.
 */
export function runNightlyStockCheck(): string[] {
  try {
    const mismatches = checkStockProjection(db);
    if (mismatches.length > 0) {
      logger.fatal({ mismatches }, "stock projection drift detected — nightly verify-stock");
    }
    return mismatches;
  } catch (err) {
    logger.error({ err }, "nightly verify-stock check failed");
    return [`check failed: ${String(err)}`];
  }
}