/**
 * R4 over-return race fixture (audit.md §4, architecture.md §4.6): one consumer
 * of the last returnable unit of an original invoice line via the real
 * `confirmReturn` service. Two different return drafts of the same original
 * line are spawned against the same DB by test/returns.test.ts.
 *
 * The per-line returnable (`original − Σ confirmed returns of the document`)
 * is re-derived in-transaction inside one `immediate` transaction, so exactly
 * one confirm passes; the loser's whole document rolls back with zero
 * movements.
 *
 * Exit codes: 0 = won the race, 3 = lost (409 over_return), 1 = any other
 * failure.
 */
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "return-worker-secret";
process.env.DATABASE_PATH = process.env.RETURN_DB!;

import { HTTPException } from "hono/http-exception";
import { db } from "../../lib/db";
import { applyMigrations } from "../../lib/migrate";
import { confirmReturn } from "../../services/returns";
import type { StaffActor } from "../../services/rbac";
import { logger } from "../../lib/logger";

const log = logger.child({ module: "return-worker" });
const outletId = process.env.RETURN_OUTLET!;

const actor: StaffActor = {
  userId: "return-worker",
  staffProfileId: "return-worker-sp",
  outletId,
  roleId: "return-worker-role",
  roleScope: "global",
  capabilities: ["canManageReturns"],
};

applyMigrations(db);
db.$client.run("PRAGMA busy_timeout = 10000");

try {
  db.transaction(
    (tx) => {
      confirmReturn(tx, actor, process.env.RETURN_DRAFT!);
    },
    { behavior: "immediate" },
  );
  log.info("return worker won the race");
  process.exit(0);
} catch (err) {
  if (err instanceof HTTPException && err.status === 409) {
    log.info("return worker lost the race");
    process.exit(3);
  }
  log.error({ err }, "return worker failed unexpectedly");
  process.exit(1);
}