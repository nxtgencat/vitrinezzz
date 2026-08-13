import type { Server } from "bun";

/**
 * Realtime hub core (`architecture.md` §4.8): one Bun-native WebSocket hub at
 * `/api/ws` with three topics — `order:{id}`, `invoice:{id}`, `stock:{outletId}`
 * — and publish-after-commit wiring on every `‡`-marked route in `api.md`.
 *
 * Publish is structural: service functions never call it (they return the
 * committed response body, which is the durable state and event record); the
 * route handler, running outside `withTx` after the transaction's promise
 * resolves, is the only call site. `withTx` callbacks are non-async (§4.1), so
 * a publish inside a transaction body is a compile error, backstopped by
 * `scripts/verify-realtime.ts`.
 *
 * Payloads are intentionally thin: `{ type, entityId, at }`, never the full
 * entity — a client treats any event as "refetch this entity". No replay
 * buffer: a publish missed during a disconnected window is recovered by the
 * client's own refetch on reconnect.
 */
export type RealtimeFact = {
  topic: string;
  type: string;
  entityId: string;
};

let server: Server<unknown> | null = null;

/**
 * Binds the hub to the running `Bun.serve` instance. Called once at boot
 * (`index.ts`) and by integration tests that boot their own server. `publish`
 * is a no-op while no server is attached (unit context, boot in progress).
 */
export function attachRealtimeServer(s: Server<unknown> | null): void {
  server = s;
}

/**
 * Publishes one fact to a topic. No-op without a server. Never called from
 * inside a service function or a transaction body — route handlers only,
 * after commit (§4.8).
 */
export function publish(topic: string, type: string, entityId: string): void {
  if (!server) return;
  server.publish(topic, JSON.stringify({ type, entityId, at: Date.now() }));
}

/** Publishes a list of facts (one `server.publish` per fact). */
export function publishFacts(facts: RealtimeFact[]): void {
  for (const fact of facts) {
    publish(fact.topic, fact.type, fact.entityId);
  }
}
