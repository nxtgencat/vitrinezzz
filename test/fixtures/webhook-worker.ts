/**
 * R7 webhook race fixture (audit.md §4, architecture.md §4.2): one consumer of
 * a single `(gateway, gatewayEventId)` via the real `confirmGatewayPayment`
 * routine. Spawned twice against the same DB by test/payments.test.ts.
 *
 * Dedupe runs inside one `immediate` transaction: the pre-check re-derives the
 * `UNIQUE(gateway, gatewayEventId)` state in-transaction, and a racing
 * duplicate hits the constraint itself — either way exactly one process
 * confirms and the other reports `replayed` with zero side effects.
 *
 * Exit codes: 0 = won (confirmed), 2 = replay, 1 = any other failure.
 */
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "webhook-worker-secret";
process.env.DATABASE_PATH = process.env.WEBHOOK_DB!;

import { db } from "../../lib/db";
import { applyMigrations } from "../../lib/migrate";
import { confirmGatewayPayment } from "../../services/payments";
import { logger } from "../../lib/logger";

const log = logger.child({ module: "webhook-worker" });

applyMigrations(db);
db.$client.run("PRAGMA busy_timeout = 10000");

try {
  const result = db.transaction(
    (tx) =>
      confirmGatewayPayment(tx, {
        gateway: process.env.WEBHOOK_GATEWAY!,
        gatewayPaymentId: process.env.WEBHOOK_REF!,
        gatewayEventId: process.env.WEBHOOK_EVENT!,
      }),
    { behavior: "immediate" },
  );
  if (result.status === "confirmed") {
    log.info("webhook worker won the race");
    process.exit(0);
  }
  log.info("webhook worker saw a replay");
  process.exit(2);
} catch (err) {
  log.error({ err }, "webhook worker failed unexpectedly");
  process.exit(1);
}