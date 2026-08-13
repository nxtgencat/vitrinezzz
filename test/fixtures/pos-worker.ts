/**
 * R2 sales race fixture (audit.md §4, architecture.md §4.3): one consumer of a
 * shared last unit of stock via the real `posCheckout` service. Spawned twice
 * against the same DB by test/sales.test.ts.
 *
 * The whole sale — order + invoice + FIFO allocation + `sale` movements — runs
 * inside one `immediate` transaction; the stock gate re-derives availability
 * in-transaction (`batchHoldings` → `allocateBatches`), never trusting the
 * projection cache. Exactly one of the two processes can pass the gate; the
 * loser's entire document rolls back.
 *
 * Exit codes: 0 = won the race, 3 = lost (409 insufficient_stock), 1 = any
 * other failure.
 */
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "pos-worker-secret";
process.env.DATABASE_PATH = process.env.POS_DB!;

import { HTTPException } from "hono/http-exception";
import { db } from "../../lib/db";
import { applyMigrations } from "../../lib/migrate";
import { posCheckout } from "../../services/sales";
import type { StaffActor } from "../../services/rbac";
import { logger } from "../../lib/logger";

const log = logger.child({ module: "pos-worker" });
const outletId = process.env.POS_OUTLET!;
const variantId = process.env.POS_VARIANT!;

const actor: StaffActor = {
  userId: "pos-worker",
  staffProfileId: "pos-worker-sp",
  outletId,
  roleId: "pos-worker-role",
  roleScope: "global",
  capabilities: ["canManageSales"],
};

applyMigrations(db);
db.$client.run("PRAGMA busy_timeout = 10000");

try {
  db.transaction(
    (tx) => {
      posCheckout(tx, actor, { outletId, items: [{ variantId, quantity: 1 }] });
    },
    { behavior: "immediate" },
  );
  log.info("pos worker won the race");
  process.exit(0);
} catch (err) {
  if (err instanceof HTTPException && err.status === 409) {
    log.info("pos worker lost the race");
    process.exit(3);
  }
  log.error({ err }, "pos worker failed unexpectedly");
  process.exit(1);
}
