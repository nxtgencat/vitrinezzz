import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { auditEvents } from "../db/schema/facts";
import { idempotencyKeys } from "../db/schema/system";

const tmpPath = join("data", `core-test-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "core-test-secret";

const { db, withTx } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");
const {
  withIdempotency,
  reapExpiredIdempotencyKeys,
  requestHash,
  respondIdempotent,
  IDEMPOTENCY_TTL_MS,
} = await import("../lib/idempotency");
const { handleError, notFoundHandler } = await import("../lib/errors");
const { docNumber } = await import("../lib/doc-number");
const { computeTaxAmountPaise, computeLineTotalPaise } = await import("../lib/money");

function idempotencyRows(operation: string, key: string) {
  return db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.operation, operation), eq(idempotencyKeys.key, key)))
    .all();
}

function auditRows(marker: string) {
  return db.select().from(auditEvents).where(eq(auditEvents.entityId, marker)).all();
}

beforeAll(async () => {
  mkdirSync("data", { recursive: true });
  applyMigrations(db);
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
});

describe("doc-number", () => {
  test("format is <PREFIX>-<7 RFC4648 base32 chars>", () => {
    for (const prefix of ["OR", "INV", "BL", "TR", "AJ", "RT", "SH", "PY"]) {
      for (let i = 0; i < 25; i++) {
        const n = docNumber(prefix);
        expect(n).toMatch(new RegExp(`^${prefix}-[A-Z2-7]{7}$`));
      }
    }
  });

  test("values are distinct", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(docNumber("INV"));
    }
    expect(seen.size).toBe(200);
  });
});

describe("money (floor-tax rule, architecture.md §4.4)", () => {
  test("taxAmountPaise = floor(unitPricePaise × quantity × taxRatePct / 100)", () => {
    expect(computeTaxAmountPaise(10000, 2, 18)).toBe(3600);
    expect(computeTaxAmountPaise(1, 1, 18)).toBe(0);
    expect(computeTaxAmountPaise(55, 3, 18)).toBe(Math.floor((55 * 3 * 18) / 100));
    expect(computeTaxAmountPaise(100, 1, 0)).toBe(0);
  });

  test("lineTotalPaise = subtotal + tax, truncation never rounds up", () => {
    expect(computeLineTotalPaise(10000, 2, 18)).toBe(23600);
    expect(computeLineTotalPaise(1, 1, 18)).toBe(1);
  });
});

describe("withIdempotency — service level", () => {
  const operation = "POST /api/service-test";
  const actorId = "actor-1";
  const body = { item: "widget", qty: 3 };

  test("missing key -> 400 idempotency_key_required", async () => {
    try {
      await withIdempotency({ operation, key: undefined, actorId, body, run: () => ({ ok: true }) });
      throw new Error("expected rejection");
    } catch (err) {
      expect((err as { status?: number }).status).toBe(400);
      expect((err as { message?: string }).message).toBe("idempotency_key_required");
    }
  });

  test("fresh execution stores a completed row with the exact hash and 24h TTL", async () => {
    const key = `fresh-${randomUUIDv7()}`;
    const marker = `fresh-${randomUUIDv7()}`;
    const before = Date.now();
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
            entityId: marker,
            action: "created",
            actorId,
            actorType: "system",
            before: null,
            after: { body },
            createdAt: Date.now(),
          })
          .run();
        return { echoed: body, execution: 1 };
      },
    });
    expect(result.replayed).toBe(false);
    expect(auditRows(marker).length).toBe(1);

    const rows = idempotencyRows(operation, key);
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("completed");
    expect(rows[0]!.requestHash).toBe(requestHash(body, actorId));
    expect(rows[0]!.expiresAt - rows[0]!.createdAt).toBe(IDEMPOTENCY_TTL_MS);
    expect(rows[0]!.createdAt).toBeGreaterThanOrEqual(before);
    expect(JSON.parse(rows[0]!.responseSnapshot)).toEqual({ echoed: body, execution: 1 });
  });

  test("replay is byte-identical, work runs exactly once", async () => {
    const key = `replay-${randomUUIDv7()}`;
    const marker = `replay-${randomUUIDv7()}`;
    let executions = 0;
    const runOnce = (): Record<string, unknown> => {
      executions++;
      return { echoed: body, execution: executions };
    };
    const first = await withIdempotency({
      operation,
      key,
      actorId,
      body,
      run: (tx) => {
        tx.insert(auditEvents)
          .values({
            id: randomUUIDv7(),
            entityType: "product",
            entityId: marker,
            action: "created",
            actorId,
            actorType: "system",
            before: null,
            after: { run: 1 },
            createdAt: Date.now(),
          })
          .run();
        return runOnce();
      },
    });
    const second = await withIdempotency({
      operation,
      key,
      actorId,
      body,
      run: (tx) => {
        tx.insert(auditEvents)
          .values({
            id: randomUUIDv7(),
            entityType: "product",
            entityId: marker,
            action: "created",
            actorId,
            actorType: "system",
            before: null,
            after: { run: 2 },
            createdAt: Date.now(),
          })
          .run();
        return runOnce();
      },
    });
    expect(executions).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.snapshot).toBe(first.snapshot);
    expect(auditRows(marker).length).toBe(1);
  });

  test("same key + different body -> 409 idempotency_mismatch, original row untouched", async () => {
    const key = `mismatch-${randomUUIDv7()}`;
    await withIdempotency({ operation, key, actorId, body, run: () => ({ ok: true }) });
    const createdAtBefore = idempotencyRows(operation, key)[0]!.createdAt;
    try {
      await withIdempotency({ operation, key, actorId, body: { item: "other" }, run: () => ({ ok: true }) });
      throw new Error("expected rejection");
    } catch (err) {
      expect((err as { status?: number }).status).toBe(409);
      expect((err as { message?: string }).message).toBe("idempotency_mismatch");
    }
    const rows = idempotencyRows(operation, key);
    expect(rows.length).toBe(1);
    expect(rows[0]!.createdAt).toBe(createdAtBefore);
  });

  test("same key + same body + different actor -> 409 (hash includes the actor id)", async () => {
    const key = `actor-${randomUUIDv7()}`;
    await withIdempotency({ operation, key, actorId: "actor-1", body, run: () => ({ ok: true }) });
    try {
      await withIdempotency({ operation, key, actorId: "actor-2", body, run: () => ({ ok: true }) });
      throw new Error("expected rejection");
    } catch (err) {
      expect((err as { status?: number }).status).toBe(409);
      expect((err as { message?: string }).message).toBe("idempotency_mismatch");
    }
  });

  test("a failed run rolls back work and idempotency row together", async () => {
    const key = `fail-${randomUUIDv7()}`;
    const marker = `fail-${randomUUIDv7()}`;
    try {
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
              entityId: marker,
              action: "created",
              actorId,
              actorType: "system",
              before: null,
              after: { fail: true },
              createdAt: Date.now(),
            })
            .run();
          throw new Error("boom");
        },
      });
      throw new Error("expected rejection");
    } catch (err) {
      expect((err as Error).message).toBe("boom");
    }
    expect(auditRows(marker).length).toBe(0);
    expect(idempotencyRows(operation, key).length).toBe(0);
    const retried = await withIdempotency({ operation, key, actorId, body, run: () => ({ ok: true }) });
    expect(retried.replayed).toBe(false);
    expect(idempotencyRows(operation, key).length).toBe(1);
  });
});

describe("R1 — HTTP envelope", () => {
  const app = new Hono();
  app.onError(handleError);
  app.notFound(notFoundHandler);

  let executions = 0;
  app.post("/api/echo", async (c) => {
    const body = await c.req.json();
    const key = c.req.header("Idempotency-Key");
    const result = await withIdempotency({
      operation: `${c.req.method} ${c.req.routePath}`,
      key,
      actorId: "http-actor",
      body,
      run: (tx) => {
        executions++;
        tx.insert(auditEvents)
          .values({
            id: randomUUIDv7(),
            entityType: "product",
            entityId: `echo-${key}`,
            action: "created",
            actorId: "http-actor",
            actorType: "system",
            before: null,
            after: { body },
            createdAt: Date.now(),
          })
          .run();
        return { echoed: body, execution: executions };
      },
    });
    return respondIdempotent(c, result);
  });

  test("missing header -> 400 VALIDATION, reason idempotency_key_required", async () => {
    const res = await app.request("/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 1 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; reason?: string; details: unknown[] } };
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.reason).toBe("idempotency_key_required");
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  test("replay is byte-identical and carries Idempotency-Replayed: true", async () => {
    const before = executions;
    const key = `http-${randomUUIDv7()}`;
    const payload = { nested: { b: 2, a: 1 }, list: [3, 1, 2] };
    const first = await app.request("/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();
    const firstBody = await first.text();

    const second = await app.request("/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(payload),
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    const secondBody = await second.text();
    expect(secondBody).toBe(firstBody);

    const parsed = JSON.parse(firstBody) as { echoed: typeof payload; execution: number };
    expect(parsed.echoed).toEqual(payload);
    expect(parsed.execution).toBe(before + 1);
    expect(executions).toBe(before + 1);
  });

  test("same key + different body -> 409 CONFLICT envelope", async () => {
    const key = `http-mismatch-${randomUUIDv7()}`;
    await app.request("/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ x: 1 }),
    });
    const res = await app.request("/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ x: 2 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; reason?: string } };
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.reason).toBe("idempotency_mismatch");
  });

  test("R1: concurrent same-key requests -> single execution, one replay, byte-identical", async () => {
    const before = executions;
    const key = `concurrent-${randomUUIDv7()}`;
    const payload = { race: true };
    const run = async (): Promise<Response> => await app.request("/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(payload),
    });
    const [resA, resB] = await Promise.all([run(), run()]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const replays = [resA, resB].filter((r) => r.headers.get("Idempotency-Replayed") === "true");
    expect(replays.length).toBe(1);
    const bodyA = await resA.text();
    const bodyB = await resB.text();
    expect(bodyA).toBe(bodyB);
    expect(JSON.parse(bodyA)).toEqual({ echoed: payload, execution: before + 1 });
    expect(executions).toBe(before + 1);
    expect(auditRows(`echo-${key}`).length).toBe(1);
  });

  test("unknown route -> 404 NOT_FOUND envelope", async () => {
    const res = await app.request("/api/does-not-exist", { method: "GET" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; reason?: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.reason).toBe("not_found");
  });
});

describe("reaper", () => {
  test("expired rows are deleted on a manual trigger, fresh rows survive", async () => {
    const now = Date.now();
    await withTx((tx) => {
      tx.insert(idempotencyKeys)
        .values([
          {
            id: randomUUIDv7(),
            operation: "POST /api/old",
            key: "old-1",
            requestHash: "h",
            responseSnapshot: "{}",
            status: "completed",
            createdAt: now - 2 * IDEMPOTENCY_TTL_MS,
            expiresAt: now - IDEMPOTENCY_TTL_MS,
          },
          {
            id: randomUUIDv7(),
            operation: "POST /api/old",
            key: "old-2",
            requestHash: "h",
            responseSnapshot: "{}",
            status: "completed",
            createdAt: now - 2 * IDEMPOTENCY_TTL_MS,
            expiresAt: now - IDEMPOTENCY_TTL_MS + 1000,
          },
          {
            id: randomUUIDv7(),
            operation: "POST /api/fresh",
            key: "fresh-1",
            requestHash: "h",
            responseSnapshot: "{}",
            status: "completed",
            createdAt: now,
            expiresAt: now + IDEMPOTENCY_TTL_MS,
          },
        ])
        .run();
    });

    const deleted = await reapExpiredIdempotencyKeys();
    expect(deleted).toBe(2);

    const oldRows = db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.operation, "POST /api/old"))
      .all();
    expect(oldRows.length).toBe(0);
    const freshRows = db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.operation, "POST /api/fresh"))
      .all();
    expect(freshRows.length).toBe(1);
    expect(freshRows[0]!.key).toBe("fresh-1");
  });
});

describe("crash-mid-transaction (audit.md §4)", () => {
  test("a process death between BEGIN and COMMIT leaves nothing; replaying the key executes exactly once", async () => {
    const crashDb = join("data", `crash-test-${randomUUIDv7()}.sqlite`);
    const crashKey = `crash-${randomUUIDv7()}`;
    const crashMarker = `marker-${randomUUIDv7()}`;
    const fixture = join(import.meta.dir, "fixtures", "crash-worker.ts");
    const env = {
      ...process.env,
      DATABASE_PATH: crashDb,
      CRASH_KEY: crashKey,
      CRASH_MARKER: crashMarker,
    };

    const crashProc = Bun.spawn(["bun", "run", fixture], {
      cwd: process.cwd(),
      env: { ...env, CRASH_MODE: "crash" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const crashExit = await crashProc.exited;
    expect(crashExit).toBe(1);

    const verifyProc = Bun.spawn(["bun", "run", fixture], {
      cwd: process.cwd(),
      env: { ...env, CRASH_MODE: "verify" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const verifyExit = await verifyProc.exited;
    if (verifyExit !== 0) {
      const stderr = await new Response(verifyProc.stderr).text();
      throw new Error(`crash verify worker failed:\n${stderr}`);
    }
    expect(verifyExit).toBe(0);

    rmSync(crashDb, { force: true });
    rmSync(`${crashDb}-wal`, { force: true });
    rmSync(`${crashDb}-shm`, { force: true });
  });
});
