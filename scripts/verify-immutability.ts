import { randomUUIDv7 } from "bun";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database, type SQLQueryBindings } from "bun:sqlite";

process.env.NODE_ENV = "test";
const tmpPath = join("data", `verify-immutability-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;

mkdirSync("data", { recursive: true });

const { logger } = await import("../lib/logger");
const log = logger.child({ module: "verify-immutability" });
const failures: string[] = [];

const migrationSql = readFileSync(join(import.meta.dir, "..", "db", "migrations", "0000_initial.sql"), "utf8");

const scratch = new Database(tmpPath);
for (const stmt of migrationSql.split("--> statement-breakpoint")) {
  const s = stmt.trim();
  if (s.length > 0) scratch.run(s);
}
scratch.run("PRAGMA foreign_keys = OFF;");

const FACT_ROWS: Record<string, { cols: string[]; values: SQLQueryBindings[] }> = {
  stock_movements: {
    cols: ["id", "variantId", "outletId", "batchId", "delta", "reason", "sourceType", "sourceId", "createdAt"],
    values: [randomUUIDv7(), "v", "o", "b", 1, "initial", "seed", null, 0],
  },
  payments: {
    cols: ["id", "paymentNumber", "direction", "partyType", "partyId", "outletId", "amountPaise", "mode", "status", "createdAt"],
    values: [randomUUIDv7(), "PY-SEED", "in", "customer", "p", "o", 100, "cash", "confirmed", 0],
  },
  order_events: {
    cols: ["id", "orderId", "type", "payload", "actorId", "actorType", "createdAt"],
    values: [randomUUIDv7(), "o", "seed", "{}", null, "system", 0],
  },
  audit_events: {
    cols: ["id", "entityType", "entityId", "action", "actorId", "actorType", "before", "after", "createdAt"],
    values: [randomUUIDv7(), "product", "p", "created", "system", "system", null, "{}", 0],
  },
};

for (const [table, { cols, values }] of Object.entries(FACT_ROWS)) {
  const placeholders = cols.map(() => "?").join(", ");
  scratch.run(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`, values);

  try {
    scratch.run(`UPDATE ${table} SET createdAt = 1`);
    failures.push(`${table}: UPDATE did not raise ABORT`);
  } catch (err) {
    if (!String(err).includes("immutable")) {
      failures.push(`${table}: UPDATE raised ${String(err)} instead of ABORT`);
    }
  }

  try {
    scratch.run(`DELETE FROM ${table}`);
    failures.push(`${table}: DELETE did not raise ABORT`);
  } catch (err) {
    if (!String(err).includes("immutable")) {
      failures.push(`${table}: DELETE raised ${String(err)} instead of ABORT`);
    }
  }
}

const FACT_IDS = ["stockMovements", "payments", "orderEvents", "auditEvents"];
const FACT_TABLES_SQL = ["stock_movements", "payments", "order_events", "audit_events"];

for (const dir of ["lib", "db", "scripts"]) {
  for (const file of new Bun.Glob(`${dir}/**/*.ts`).scanSync({ cwd: process.cwd(), absolute: true })) {
    const rel = file.replace(process.cwd() + "/", "");
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const hasWriteCall = /\.(insert|update|delete)\(/.test(line) || /(insert\s+into|update\s+|delete\s+from)\s+`?[a-z_]*/.test(line.toLowerCase());
      const namesFact = new RegExp(`\\b(${FACT_IDS.join("|")})\\b`).test(line) || new RegExp(`\\b(${FACT_TABLES_SQL.join("|")})\\b`).test(line.toLowerCase());
      if (hasWriteCall && namesFact) {
        failures.push(`${rel}:${i + 1}: direct write to a [FACT] table outside services/ — writes must live in the owning domain service`);
      }
    });
  }
}

scratch.close();
rmSync(tmpPath, { force: true });
rmSync(`${tmpPath}-wal`, { force: true });
rmSync(`${tmpPath}-shm`, { force: true });

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0] }, "verify-immutability FAILED");
  process.exit(1);
}
log.info("verify-immutability PASS");
