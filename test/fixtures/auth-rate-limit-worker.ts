import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Spawned by `smoke-ops.ts` with a production env (`NODE_ENV=production`, no
 * `TEST=true`) so better-auth's built-in fixed-window limiter is live
 * (`lib/auth.ts` — disabled only under test). Asserts the documented default
 * (`architecture.md` §4.14): sign-in is 3 per 10s per IP; the 4th attempt in
 * the window is `429`. Exits 0 on success, 1 on failure.
 */
process.env.NODE_ENV = "production";
const tmpPath = join("data", `auth-rate-limit-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
if (!process.env.AUTH_SECRET) process.env.AUTH_SECRET = "auth-rate-limit-secret";
if (!process.env.SUPERUSER_EMAIL) process.env.SUPERUSER_EMAIL = "admin@authlimit.test";
if (!process.env.SUPERUSER_PASSWORD) process.env.SUPERUSER_PASSWORD = "admin-pass-123";

mkdirSync(dirname(tmpPath), { recursive: true });

const { logger } = await import("../../lib/logger");
const log = logger.child({ module: "auth-rate-limit-worker" });
const failures: string[] = [];

const { db } = await import("../../lib/db");
const { applyMigrations } = await import("../../lib/migrate");
const { bootstrapAdmin } = await import("../../lib/auth");
const { app } = await import("../../app");

applyMigrations(db);
await bootstrapAdmin();

async function signInAttempt(): Promise<number> {
  const res = await app.fetch(
    new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@authlimit.test", password: "definitely-wrong" }),
    }),
  );
  return res.status;
}

try {
  const statuses: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    statuses.push(await signInAttempt());
  }
  const expected = [401, 401, 401, 429];
  for (let i = 0; i < expected.length; i += 1) {
    if (statuses[i] !== expected[i]) {
      failures.push(`attempt ${i + 1}: expected ${expected[i]}, got ${statuses[i]} (all: ${statuses.join(",")})`);
    }
  }
} catch (err) {
  failures.push(`worker threw: ${String(err)}`);
} finally {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
}

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0], all: failures }, "auth-rate-limit-worker FAILED");
  process.exit(1);
}
log.info("auth-rate-limit-worker PASS");