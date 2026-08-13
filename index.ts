import { Hono } from "hono";
import { db } from "./lib/db";
import { logger } from "./lib/logger";
import { applyMigrations } from "./lib/migrate";

applyMigrations(db);

export const app = new Hono();

app.get("/api/health", (c) => {
  const start = performance.now();
  let dbTimeMs: number;
  try {
    db.$client.query("SELECT 1").get();
    dbTimeMs = performance.now() - start;
  } catch (err) {
    logger.error({ err }, "health db probe failed");
    return c.json({
      status: "degraded",
      dbTimeMs: performance.now() - start,
      ledgerCounts: {},
    });
  }
  return c.json({ status: "ok", dbTimeMs, ledgerCounts: {} });
});

const port = Number(process.env.PORT ?? 3000);
const server = Bun.serve({ port, fetch: app.fetch });
logger.info({ port: server.port }, "vitrine listening");
