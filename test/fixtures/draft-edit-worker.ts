/**
 * R5 race fixture (audit.md §4, architecture.md §4.3): one versioned edit of a
 * shared draft transfer. Spawned twice against the same DB by
 * test/stock.test.ts with the same `version` but different line payloads.
 *
 * Both callers read the draft's version inside their own `immediate`
 * transaction; the winner's conditional `UPDATE … WHERE id AND version` bumps
 * it, the loser's re-read sees the new version → 409 `stale_version`, zero
 * rows changed.
 *
 * Exit codes: 0 = won the race, 3 = lost (409 stale_version), 1 = any other
 * failure.
 */
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "draft-edit-worker-secret";
process.env.DATABASE_PATH = process.env.DRAFT_DB!;

import { HTTPException } from "hono/http-exception";
import { db } from "../../lib/db";
import { applyMigrations } from "../../lib/migrate";
import { updateTransfer } from "../../services/inventory";
import { logger } from "../../lib/logger";

const log = logger.child({ module: "draft-edit-worker" });
const transferId = process.env.DRAFT_ID!;
const version = Number(process.env.DRAFT_VERSION);
const fromOutletId = process.env.DRAFT_FROM!;
const toOutletId = process.env.DRAFT_TO!;
const variantId = process.env.DRAFT_VARIANT!;
const batchId = process.env.DRAFT_BATCH!;
const quantity = Number(process.env.DRAFT_QTY);

const actor: import("../../services/rbac").StaffActor = {
  userId: "draft-edit-race",
  staffProfileId: "draft-edit-race-sp",
  outletId: fromOutletId,
  roleId: "draft-edit-race-role",
  roleScope: "global",
  capabilities: ["canManageInventory"],
};

applyMigrations(db);
db.$client.run("PRAGMA busy_timeout = 10000");

try {
  db.transaction(
    (tx) => {
      updateTransfer(tx, actor, transferId, {
        fromOutletId,
        toOutletId,
        items: [{ variantId, batchId, quantity }],
        version,
      });
    },
    { behavior: "immediate" },
  );
  log.info("draft edit won the race");
  process.exit(0);
} catch (err) {
  if (err instanceof HTTPException && err.status === 409) {
    log.info("draft edit lost the race");
    process.exit(3);
  }
  log.error({ err }, "draft edit failed unexpectedly");
  process.exit(1);
}