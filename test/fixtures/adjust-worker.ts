/**
 * R2 race fixture (audit.md §4, architecture.md §4.3): one consumer of a shared
 * stock level. Spawned twice against the same DB by test/stock.test.ts.
 *
 * The gate re-derives available stock INSIDE the `immediate` transaction
 * (`sumStockAtBatch`) — never trusting the projection cache — then writes
 * `adjustment_out` -1. Exactly one of the two processes can pass the gate.
 *
 * Exit codes: 0 = won the race, 3 = lost (409 insufficient_stock), 1 = any
 * other failure.
 */
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "adjust-worker-secret";
process.env.DATABASE_PATH = process.env.ADJUST_DB!;

import { HTTPException } from "hono/http-exception";
import { db } from "../../lib/db";
import { applyMigrations } from "../../lib/migrate";
import { sumStockAtBatch, writeMovement } from "../../services/stock";
import { logger } from "../../lib/logger";

const log = logger.child({ module: "adjust-worker" });
const variantId = process.env.ADJUST_VARIANT!;
const outletId = process.env.ADJUST_OUTLET!;
const batchId = process.env.ADJUST_BATCH!;

applyMigrations(db);
db.$client.run("PRAGMA busy_timeout = 10000");

try {
  db.transaction(
    (tx) => {
      const available = sumStockAtBatch(tx, variantId, outletId, batchId);
      if (available < 1) {
        throw new HTTPException(409, { message: "insufficient_stock" });
      }
      writeMovement(tx, {
        variantId,
        outletId,
        batchId,
        delta: -1,
        reason: "adjustment_out",
        sourceType: "adjustment",
        sourceId: "race",
      });
    },
    { behavior: "immediate" },
  );
  log.info("consumer won the race");
  process.exit(0);
} catch (err) {
  if (err instanceof HTTPException && err.status === 409) {
    log.info("consumer lost the race");
    process.exit(3);
  }
  log.error({ err }, "consumer failed unexpectedly");
  process.exit(1);
}