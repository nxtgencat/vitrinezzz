import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ServerWebSocket } from "bun";
import { customers } from "../db/schema/catalog";
import { invoices, orders } from "../db/schema/orders";
import { staffProfiles } from "../db/schema/org";
import { auth } from "../lib/auth";
import { db } from "../lib/db";
import { logger } from "../lib/logger";

export const realtimeRoutes = new Hono();

/**
 * Hub actor (`architecture.md` §4.8): a valid staff or customer session. Staff
 * means an active staff profile — the hub's "any staff" authorization needs no
 * capability and no role resolution beyond the profile. A session whose user
 * has neither profile is 403.
 */
type WsActor =
  | { kind: "staff"; userId: string }
  | { kind: "customer"; userId: string; customerId: string };

async function resolveWsActor(headers: Headers): Promise<WsActor> {
  const session = await auth.api.getSession({ headers });
  if (!session) throw new HTTPException(401, { message: "unauthorized" });
  const staff = db.select().from(staffProfiles).where(eq(staffProfiles.userId, session.user.id)).get();
  if (staff && staff.isActive === 1) return { kind: "staff", userId: session.user.id };
  const customer = db.select().from(customers).where(eq(customers.userId, session.user.id)).get();
  if (customer && customer.isActive === 1) return { kind: "customer", userId: session.user.id, customerId: customer.id };
  throw new HTTPException(403, { message: "not a staff member or customer" });
}

const topicIdSchema = z.uuid();

/**
 * Per-topic authorization (`architecture.md` §4.8): `order:{id}` and
 * `invoice:{id}` are visible to their own customer or any staff;
 * `stock:{outletId}` is staff-only. An unknown topic kind, a non-uuid id, an
 * unknown document, or another customer's document is denied — a missing
 * document is indistinguishable from an unauthorized one (no existence leak).
 */
function authorizeTopic(topic: string, actor: WsActor): boolean {
  const colon = topic.indexOf(":");
  if (colon === -1) return false;
  const kind = topic.slice(0, colon);
  const id = topic.slice(colon + 1);
  if (topicIdSchema.safeParse(id).success === false) return false;
  if (kind === "stock") return actor.kind === "staff";
  if (kind !== "order" && kind !== "invoice") return false;
  if (actor.kind === "staff") return true;
  const row =
    kind === "order"
      ? db.select({ customerId: orders.customerId }).from(orders).where(eq(orders.id, id)).get()
      : db.select({ customerId: invoices.customerId }).from(invoices).where(eq(invoices.id, id)).get();
  return row !== undefined && row.customerId === actor.customerId;
}

const subscribeFrameSchema = z
  .object({
    op: z.literal("subscribe"),
    topics: z.array(z.string().min(1).max(200)).min(1).max(64),
  })
  .strict();

function sendError(ws: { send(data: string): void }, reason: string): void {
  ws.send(JSON.stringify({ op: "error", reason }));
}

/**
 * The one hub at `/api/ws` (`architecture.md` §4.8). The upgrade requires a
 * valid staff or customer session (401 otherwise — the upgrade is refused
 * before any socket exists). The subscribe frame is
 * `{ op: "subscribe", topics: [...] }`; every topic is authorized against the
 * actor before the socket subscribes, and one unauthorized topic closes the
 * connection (1008). The server keeps no replay buffer — a publish missed
 * during a disconnected window is recovered by the client's own refetch.
 */
realtimeRoutes.get(
  "/ws",
  upgradeWebSocket(async (c) => {
    const actor = await resolveWsActor(c.req.raw.headers);
    return {
      onOpen() {
        logger.debug({ userId: actor.userId, kind: actor.kind }, "ws connected");
      },
      onMessage(evt, ws) {
        if (typeof evt.data !== "string") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(evt.data);
        } catch {
          sendError(ws, "invalid JSON");
          return;
        }
        const frame = subscribeFrameSchema.safeParse(parsed);
        if (!frame.success) {
          sendError(ws, "invalid subscribe frame");
          return;
        }
        for (const topic of frame.data.topics) {
          if (!authorizeTopic(topic, actor)) {
            sendError(ws, `unauthorized topic: ${topic}`);
            ws.close(1008, "unauthorized topic");
            return;
          }
        }
        const socket = ws.raw as unknown as ServerWebSocket;
        for (const topic of frame.data.topics) {
          socket.subscribe(topic);
        }
        logger.debug({ userId: actor.userId, topics: frame.data.topics }, "ws subscribed");
      },
    };
  }),
);