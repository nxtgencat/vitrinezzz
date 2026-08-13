import { websocket } from "hono/bun";
import { applyMigrations } from "./lib/migrate";
import { db } from "./lib/db";
import { logger } from "./lib/logger";
import { bootstrapAdmin } from "./lib/auth";
import { reapExpiredIdempotencyKeys } from "./lib/idempotency";
import { attachRealtimeServer } from "./lib/realtime";
import { app } from "./app";

applyMigrations(db);
await bootstrapAdmin();

const port = Number(process.env.PORT ?? 3000);
const server = Bun.serve({ port, fetch: app.fetch, websocket });
attachRealtimeServer(server);
logger.info({ port: server.port }, "vitrine listening");

Bun.cron("0 3 * * *", () => {
  void reapExpiredIdempotencyKeys();
});