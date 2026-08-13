/**
 * R3 over-payment race fixture (audit.md §4, architecture.md §4.3): one
 * consumer of a single paisa of outstanding balance on a shared invoice via
 * the real `recordPayment` service. Spawned twice against the same DB by
 * test/payments.test.ts.
 *
 * The cap (`outstanding = total − (Σ in − Σ out)`) is re-derived in-transaction
 * inside one `immediate` transaction — never from a cache — so exactly one
 * process can pass; the loser's entire row rolls back.
 *
 * Exit codes: 0 = won the race, 3 = lost (409 over_payment), 1 = any other
 * failure.
 */
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "payment-worker-secret";
process.env.DATABASE_PATH = process.env.PAY_DB!;

import { HTTPException } from "hono/http-exception";
import { db } from "../../lib/db";
import { applyMigrations } from "../../lib/migrate";
import { recordPayment } from "../../services/payments";
import type { StaffActor } from "../../services/rbac";
import { logger } from "../../lib/logger";

const log = logger.child({ module: "payment-worker" });
const outletId = process.env.PAY_OUTLET!;
const invoiceId = process.env.PAY_INVOICE!;
const customerId = process.env.PAY_CUSTOMER!;

const actor: StaffActor = {
  userId: "payment-worker",
  staffProfileId: "payment-worker-sp",
  outletId,
  roleId: "payment-worker-role",
  roleScope: "global",
  capabilities: ["canManagePayments"],
};

applyMigrations(db);
db.$client.run("PRAGMA busy_timeout = 10000");

try {
  db.transaction(
    (tx) => {
      recordPayment(tx, actor, {
        direction: "in",
        partyType: "customer",
        partyId: customerId,
        invoiceId,
        amountPaise: 1,
        mode: "cash",
        outletId,
      });
    },
    { behavior: "immediate" },
  );
  log.info("payment worker won the race");
  process.exit(0);
} catch (err) {
  if (err instanceof HTTPException && err.status === 409) {
    log.info("payment worker lost the race");
    process.exit(3);
  }
  log.error({ err }, "payment worker failed unexpectedly");
  process.exit(1);
}