import { Hono } from "hono";
import { db } from "./lib/db";
import { logger } from "./lib/logger";
import { auth } from "./lib/auth";
import { handleError, notFoundHandler } from "./lib/errors";
import { auditRoutes } from "./routes/audit";
import { catalogRoutes } from "./routes/catalog";
import { fulfillmentRoutes } from "./routes/fulfillment";
import { inventoryRoutes } from "./routes/inventory";
import { orgRoutes } from "./routes/org";
import { paymentsRoutes } from "./routes/payments";
import { purchasingRoutes } from "./routes/purchasing";
import { realtimeRoutes } from "./routes/realtime";
import { returnsRoutes } from "./routes/returns";
import { salesRoutes } from "./routes/sales";
import { storefrontRoutes } from "./routes/storefront";
import { webhookRoutes } from "./routes/webhooks";

/**
 * The assembled Hono app — every route, hook, and middleware. `index.ts`
 * boots it; tests and smoke scripts import it directly without starting a
 * server. `AppType` is what `hc<AppType>()` consumes on both frontends.
 */
export const app = new Hono();

app.onError(handleError);
app.notFound(notFoundHandler);

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

/**
 * The four [FACT] tables (`schema.md` §9/§10/§11). `ledgerCounts` reports how
 * many rows each holds; a failure on any one of them degrades the status.
 */
const LEDGER_COUNT_QUERIES: [string, string][] = [
  ["stockMovements", "stock_movements"],
  ["payments", "payments"],
  ["orderEvents", "order_events"],
  ["auditEvents", "audit_events"],
];

/**
 * Health never `500`s for a reportable DB condition — every DB touch here is
 * wrapped, and any failure reports `{ status: "degraded" }` at `200` so
 * uptime monitors alert on body content, not status code (`api.md` §10).
 * `ledgerCounts` carries the partial counts gathered up to the failure.
 */
app.get("/api/health", (c) => {
  const start = performance.now();
  const ledgerCounts: Record<string, number> = {};
  let ok = true;
  try {
    db.$client.query("SELECT 1").get();
  } catch (err) {
    logger.error({ err }, "health db probe failed");
    ok = false;
  }
  for (const [key, table] of LEDGER_COUNT_QUERIES) {
    if (!ok) break;
    try {
      const row = db.$client.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number } | undefined;
      ledgerCounts[key] = Number(row?.n ?? 0);
    } catch (err) {
      logger.error({ err, table }, "health ledger count failed");
      ok = false;
    }
  }
  return c.json({
    status: ok ? "ok" : "degraded",
    dbTimeMs: performance.now() - start,
    ledgerCounts,
  });
});

app.route("/api", catalogRoutes);
app.route("/api", orgRoutes);
app.route("/api", auditRoutes);
app.route("/api", inventoryRoutes);
app.route("/api", purchasingRoutes);
app.route("/api", paymentsRoutes);
app.route("/api", salesRoutes);
app.route("/api", storefrontRoutes);
app.route("/api", webhookRoutes);
app.route("/api", returnsRoutes);
app.route("/api", fulfillmentRoutes);
app.route("/api", realtimeRoutes);

export type AppType = typeof app;
