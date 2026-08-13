import { Hono } from "hono";
import { db } from "./lib/db";
import { logger } from "./lib/logger";
import { auth } from "./lib/auth";
import { handleError, notFoundHandler } from "./lib/errors";
import { catalogRoutes } from "./routes/catalog";
import { inventoryRoutes } from "./routes/inventory";
import { paymentsRoutes } from "./routes/payments";
import { purchasingRoutes } from "./routes/purchasing";
import { salesRoutes } from "./routes/sales";
import { storefrontRoutes } from "./routes/storefront";

/**
 * The assembled Hono app — every route, hook, and middleware. `index.ts`
 * boots it; tests and smoke scripts import it directly without starting a
 * server. `AppType` is what `hc<AppType>()` consumes on both frontends.
 */
export const app = new Hono();

app.onError(handleError);
app.notFound(notFoundHandler);

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

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

app.route("/api", catalogRoutes);
app.route("/api", inventoryRoutes);
app.route("/api", purchasingRoutes);
app.route("/api", paymentsRoutes);
app.route("/api", salesRoutes);
app.route("/api", storefrontRoutes);

export type AppType = typeof app;