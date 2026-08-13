/**
 * R6/R9 race fixture (audit.md §4, architecture.md §4.3): one audited batch
 * creation against a shared DB. Spawned twice by test/stock.test.ts — R6 with
 * the same `(variantId, batchNumber)` from both processes (exactly one must
 * survive the `UNIQUE(variantId, batchNumber)` backstop), R9 with two
 * different batch numbers on the same variant (both must succeed and each
 * write its `audit_events` row in the same transaction).
 *
 * Exit codes: 0 = batch created, 3 = lost (409 duplicate_batch), 1 = any
 * other failure.
 */
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "batch-worker-secret";
process.env.DATABASE_PATH = process.env.BATCH_DB!;

import { HTTPException } from "hono/http-exception";
import { db } from "../../lib/db";
import { applyMigrations } from "../../lib/migrate";
import { createBatch } from "../../services/stock";
import { logger } from "../../lib/logger";

const log = logger.child({ module: "batch-worker" });
const variantId = process.env.BATCH_VARIANT!;
const batchNumber = process.env.BATCH_NUMBER!;

const actor: import("../../services/rbac").StaffActor = {
  userId: "batch-race",
  staffProfileId: "batch-race-sp",
  outletId: "batch-race-outlet",
  roleId: "batch-race-role",
  roleScope: "global",
  capabilities: ["canManageInventory"],
};

applyMigrations(db);
db.$client.run("PRAGMA busy_timeout = 10000");

try {
  db.transaction(
    (tx) => {
      createBatch(tx, actor, { variantId, batchNumber, costPricePaise: 100 });
    },
    { behavior: "immediate" },
  );
  log.info("batch created");
  process.exit(0);
} catch (err) {
  if (err instanceof HTTPException && err.status === 409) {
    log.info("batch create lost the race");
    process.exit(3);
  }
  log.error({ err }, "batch create failed unexpectedly");
  process.exit(1);
}