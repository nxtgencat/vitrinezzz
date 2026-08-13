import { randomUUIDv7 } from "bun";
import { and, eq, lt } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { idempotencyKeys } from "../db/schema/system";
import { withTx } from "./db";
import type { Tx } from "./db";
import { logger } from "./logger";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export type IdempotencyResult = {
  replayed: boolean;
  snapshot: string;
  /**
   * The `run` callback's return value — the committed response body — present
   * only on a fresh execution, absent on a replay. `‡` routes derive their
   * realtime publish facts from it and must not publish on a replay: the
   * original execution already published (§4.8).
   */
  value?: Record<string, unknown>;
};

export type IdempotencyRun = (tx: Tx) => Record<string, unknown>;

/**
 * Sorts object keys recursively so that semantically identical bodies hash
 * equally regardless of key order (requestHash canonicalization, §4.2).
 */
function canonicalJson(value: unknown): string {
  function sort(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sort);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        out[key] = sort((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  }
  return JSON.stringify(sort(value));
}

/**
 * requestHash = SHA-256 of the canonicalized (sorted-key) request body JSON plus
 * the actor's user id (`architecture.md` §4.2). An absent body hashes as `null`.
 */
export function requestHash(body: unknown, actorId: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonicalJson(body ?? null));
  hasher.update("\n");
  hasher.update(actorId);
  return hasher.digest("hex");
}

/**
 * The one idempotency mechanism, used by every mutating route (`I` in `api.md`).
 *
 * - Missing `Idempotency-Key` → `400 VALIDATION`, reason `idempotency_key_required`.
 * - Same (operation, key) + same hash → replay the stored response verbatim.
 * - Same (operation, key) + different hash → `409 CONFLICT`, reason
 *   `idempotency_mismatch`.
 * - Absent → run the operation and insert the row, all in one transaction.
 *
 * `run` executes inside the same `immediate` transaction as the idempotency
 * check/insert (statement order T3, `architecture.md` §4.1/§4.2) and must return
 * the exact response body — it is stored and replayed byte-for-byte. The caller
 * (route handler) sends `snapshot` via `respondIdempotent`.
 */
export async function withIdempotency(opts: {
  operation: string;
  key: string | undefined;
  actorId: string;
  body: unknown;
  run: IdempotencyRun;
}): Promise<IdempotencyResult> {
  const key = opts.key;
  if (!key) {
    throw new HTTPException(400, { message: "idempotency_key_required" });
  }
  const hash = requestHash(opts.body, opts.actorId);
  return withTx((tx) => {
    const existing = tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.operation, opts.operation), eq(idempotencyKeys.key, key)))
      .get();
    if (existing) {
      if (existing.requestHash !== hash) {
        throw new HTTPException(409, { message: "idempotency_mismatch" });
      }
      return { replayed: true, snapshot: existing.responseSnapshot };
    }
    const value = opts.run(tx);
    const snapshot = JSON.stringify(value);
    const now = Date.now();
    tx.insert(idempotencyKeys)
      .values({
        id: randomUUIDv7(),
        operation: opts.operation,
        key,
        requestHash: hash,
        responseSnapshot: snapshot,
        status: "completed",
        createdAt: now,
        expiresAt: now + IDEMPOTENCY_TTL_MS,
      })
      .run();
    return { replayed: false, snapshot, value };
  });
}

/**
 * Route-side response for a `withIdempotency` result: sets
 * `Idempotency-Replayed: true` on a replay and returns the stored snapshot
 * byte-for-byte (`architecture.md` §4.2).
 */
export function respondIdempotent(c: Context, result: IdempotencyResult): Response {
  if (result.replayed) {
    c.header("Idempotency-Replayed", "true");
  }
  return c.body(result.snapshot, 200, { "content-type": "application/json" });
}

/**
 * Deletes expired idempotency rows (TTL = 24h, `architecture.md` §4.2). This is
 * the nightly reaper's body; index.ts registers it on a `Bun.cron`. Never throws
 * past its own catch — a failed reap must not affect the running process.
 */
export async function reapExpiredIdempotencyKeys(): Promise<number> {
  try {
    let deleted = 0;
    await withTx((tx) => {
      deleted = tx
        .select({ id: idempotencyKeys.id })
        .from(idempotencyKeys)
        .where(lt(idempotencyKeys.expiresAt, Date.now()))
        .all().length;
      tx.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, Date.now())).run();
    });
    if (deleted > 0) logger.info({ deleted }, "expired idempotency keys reaped");
    return deleted;
  } catch (err) {
    logger.error({ err }, "idempotency reaper failed");
    return 0;
  }
}
