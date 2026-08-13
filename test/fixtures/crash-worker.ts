/**
 * Crash-mid-transaction fixture (audit.md §4). Spawned by test/core.test.ts with
 * `CRASH_MODE=crash|verify` against its own temp DB.
 *
 * `crash` mode: runs one idempotent operation whose work inserts an audit row and
 * then dies (process.exit) between BEGIN and COMMIT — no COMMIT is ever issued.
 *
 * `verify` mode: reopens the same DB file (WAL recovery rolls back the dead
 * transaction), asserts no partial rows survived, then replays the same key and
 * asserts it executes cleanly exactly once.
 */
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "crash-worker-secret";

import { randomUUIDv7 } from "bun";
import { and, eq } from "drizzle-orm";
import { auditEvents } from "../../db/schema/facts";
import { idempotencyKeys } from "../../db/schema/system";
import { db } from "../../lib/db";
import { applyMigrations } from "../../lib/migrate";
import { withIdempotency } from "../../lib/idempotency";

const operation = "POST /api/crash-test";
const key = process.env.CRASH_KEY!;
const actorId = "crash-actor";
const body = { crash: true };
const marker1 = process.env.CRASH_MARKER!;
const marker2 = `${marker1}-replay`;

function fail(message: string): never {
  throw new Error(message);
}

applyMigrations(db);

if (process.env.CRASH_MODE === "crash") {
  await withIdempotency({
    operation,
    key,
    actorId,
    body,
    run: (tx) => {
      tx.insert(auditEvents)
        .values({
          id: randomUUIDv7(),
          entityType: "product",
          entityId: marker1,
          action: "created",
          actorId,
          actorType: "system",
          before: null,
          after: { crash: true },
          createdAt: Date.now(),
        })
        .run();
      process.exit(1);
    },
  });
  process.exit(2);
}

const countIdempotencyRows = (): number =>
  db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.operation, operation), eq(idempotencyKeys.key, key)))
    .all().length;

const countAuditRows = (marker: string): number =>
  db.select().from(auditEvents).where(eq(auditEvents.entityId, marker)).all().length;

if (countIdempotencyRows() !== 0) fail("idempotency row survived the crash");
if (countAuditRows(marker1) !== 0) fail("work rows survived the crash");

const result = await withIdempotency({
  operation,
  key,
  actorId,
  body,
  run: (tx) => {
    tx.insert(auditEvents)
      .values({
        id: randomUUIDv7(),
        entityType: "product",
        entityId: marker2,
        action: "created",
        actorId,
        actorType: "system",
        before: null,
        after: { replay: true },
        createdAt: Date.now(),
      })
      .run();
    return { ok: true };
  },
});

if (result.replayed) fail("replay after a crash must execute fresh, not replay a rolled-back row");
if (countIdempotencyRows() !== 1) fail("expected exactly one idempotency row after the replay");
if (countAuditRows(marker2) !== 1) fail("expected exactly one audit row from the replay");
if (countAuditRows(marker1) !== 0) fail("crashed work resurrected after replay");
