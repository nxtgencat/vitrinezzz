import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { websocket } from "hono/bun";

const tmpPath = join("data", `realtime-test-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "realtime-test-secret";
process.env.SUPERUSER_EMAIL = "admin@realtime.test";
process.env.SUPERUSER_PASSWORD = "admin-pass-123";
process.env.WEBHOOK_SECRET_TESTGW = "realtime-gateway-secret";
delete process.env.BUN_CHROME_PATH;

mkdirSync("data", { recursive: true });

const { db } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");
const { bootstrapAdmin } = await import("../lib/auth");
const { app } = await import("../app");
const { attachRealtimeServer } = await import("../lib/realtime");
const { webhookSignature } = await import("../lib/webhook");
const { outlets } = await import("../db/schema/org");
const { batches } = await import("../db/schema/catalog");

let baseUrl: string;
let outletId: string;
let staffCookies: string;

type Received = { topic: string; type: string; entityId: string; at: number };

function wsConnect(cookies: string | null): { socket: WebSocket; messages: Received[]; opened: Promise<void>; closed: Promise<CloseEvent | null>; errors: Promise<Event | null> } {
  const messages: Received[] = [];
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/ws`, {
    headers: cookies ? { cookie: cookies } : {},
  });
  const opened = new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onErr);
      resolve();
    };
    const onErr = (): void => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onErr);
      reject(new Error("ws open failed"));
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onErr);
  });
  socket.addEventListener("message", (evt) => {
    if (typeof evt.data !== "string") return;
    try {
      const parsed = JSON.parse(evt.data) as { op?: string; reason?: string; type?: string; entityId?: string; at?: number };
      if (parsed.op === "error") {
        messages.push({ topic: "", type: "hub.error", entityId: parsed.reason ?? "", at: Date.now() });
        return;
      }
      messages.push({ topic: "", type: parsed.type ?? "", entityId: parsed.entityId ?? "", at: parsed.at ?? Date.now() });
    } catch {
      // non-event frames are ignored by the collector
    }
  });
  const closed = new Promise<CloseEvent | null>((resolve) => {
    socket.addEventListener("close", (evt) => resolve(evt as CloseEvent));
  });
  const errors = new Promise<Event | null>((resolve) => {
    socket.addEventListener("error", (evt) => resolve(evt as Event));
  });
  return { socket, messages, opened, closed, errors };
}

function subscribe(socket: WebSocket, topics: string[]): void {
  socket.send(JSON.stringify({ op: "subscribe", topics }));
}

function byType(messages: Received[]): Map<string, Received[]> {
  const map = new Map<string, Received[]>();
  for (const m of messages) {
    const list = map.get(m.type) ?? [];
    list.push(m);
    map.set(m.type, list);
  }
  return map;
}

async function cookiesOf(res: Response): Promise<string> {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => c.length > 0)
    .join("; ");
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await app.fetch(
    new Request(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(res.status).toBe(200);
  return cookiesOf(res);
}

async function signUp(name: string, email: string, password: string): Promise<string> {
  const res = await app.fetch(
    new Request(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    }),
  );
  expect(res.status).toBe(200);
  return cookiesOf(res);
}

async function api(
  cookies: string | null,
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string; extraHeaders?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookies) headers["cookie"] = cookies;
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  if (init.extraHeaders) Object.assign(headers, init.extraHeaders);
  return app.fetch(
    new Request(`${baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    }),
  );
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(async () => {
  applyMigrations(db);
  await bootstrapAdmin();
  server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
  baseUrl = `http://127.0.0.1:${server.port}`;
  attachRealtimeServer(server);
  const outlet = db.select().from(outlets).limit(1).get();
  expect(outlet).toBeDefined();
  outletId = outlet!.id;
  staffCookies = await signIn("admin@realtime.test", "admin-pass-123");
});

afterAll(() => {
  server?.stop(true);
  attachRealtimeServer(null);
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
});

describe("realtime — live publish after commit (architecture.md §4.8)", () => {
  test("six distinct event types observed live across the hub", async () => {
    const productRes = await api(staffCookies, "/api/products", {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: { name: "RT Soda", gstRatePct: 0, baseVariant: { name: "RT Soda 500ml", sku: "RT-1", costPricePaise: 1000, sellingPricePaise: 2000 } },
    });
    expect(productRes.status).toBe(200);
    const product = await json<{ baseVariant: { id: string } }>(productRes);
    const variantId = product.baseVariant.id;

    const vendorRes = await api(staffCookies, "/api/vendors", {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: { name: "RT Supplies", phone: "9876511111" },
    });
    const vendor = await json<{ id: string }>(vendorRes);
    const billRes = await api(staffCookies, "/api/purchase-bills", {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: { vendorId: vendor.id, outletId, items: [{ variantId, batchNumber: "RT-A", quantity: 10, unitCostPaise: 1000, taxRatePct: 0 }] },
    });
    const bill = await json<{ id: string }>(billRes);
    const issueBillRes = await api(staffCookies, `/api/purchase-bills/${bill.id}/issue`, {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: {},
    });
    expect(issueBillRes.status).toBe(200);
    expect(db.select().from(batches).all().length).toBe(1);

    const orderRes = await api(staffCookies, "/api/orders", {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: { orderType: "manual", outletId },
    });
    expect(orderRes.status).toBe(200);
    const order = await json<{ id: string }>(orderRes);

    const staffWs = wsConnect(staffCookies);
    await staffWs.opened;
    subscribe(staffWs.socket, [`order:${order.id}`, `stock:${outletId}`]);
    await Bun.sleep(50);

    const confirmRes = await api(staffCookies, `/api/orders/${order.id}/confirm`, {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: {},
    });
    expect(confirmRes.status).toBe(200);
    const confirmed = await json<{ id: string; invoice: { id: string } }>(confirmRes);
    const invoiceId = confirmed.invoice.id;
    await Bun.sleep(50);
    const afterConfirm = byType(staffWs.messages);
    expect(afterConfirm.get("order.confirmed")?.length).toBe(1);

    subscribe(staffWs.socket, [`invoice:${invoiceId}`]);
    await Bun.sleep(50);

    const invoiceRes = await api(staffCookies, `/api/invoices/${invoiceId}/issue`, {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: {},
    });
    expect(invoiceRes.status).toBe(200);
    await Bun.sleep(50);
    const afterIssue = byType(staffWs.messages);
    expect(afterIssue.get("invoice.issued")?.length).toBe(2);
    expect(afterIssue.get("stock.changed")?.length).toBe(1);

    const shipmentRes = await api(staffCookies, "/api/shipments", {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: { invoiceId, carrier: "RT-Courier", awbNumber: "AWB-1" },
    });
    expect(shipmentRes.status).toBe(200);
    const shipment = await json<{ id: string }>(shipmentRes);
    const dispatchRes = await api(staffCookies, `/api/shipments/${shipment.id}/dispatch`, {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: {},
    });
    expect(dispatchRes.status).toBe(200);
    await Bun.sleep(50);
    const deliverRes = await api(staffCookies, `/api/shipments/${shipment.id}/deliver`, {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: {},
    });
    expect(deliverRes.status).toBe(200);
    await Bun.sleep(50);
    const afterShip = byType(staffWs.messages);
    expect(afterShip.get("shipment.dispatched")?.length).toBe(1);
    expect(afterShip.get("shipment.delivered")?.length).toBe(1);

    const custCookies = await signUp("RT Shopper", "shopper@realtime.test", "shopper-pass-1");
    const addrRes = await api(custCookies, "/api/storefront/addresses", {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: { label: "Home", line1: "1 RT Street", city: "Pune", state: "MH", pincode: "411001" },
    });
    const address = await json<{ id: string }>(addrRes);
    await api(custCookies, "/api/storefront/cart", {
      method: "PUT",
      idempotencyKey: randomUUIDv7(),
      body: { variantId, quantity: 1 },
    });
    const checkoutRes = await api(custCookies, "/api/storefront/checkout", {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: { custAddressId: address.id, paymentMode: "gateway" },
    });
    expect(checkoutRes.status).toBe(200);
    const checkout = await json<{ order: { id: string }; checkoutReference: string }>(checkoutRes);

    const custWs = wsConnect(custCookies);
    await custWs.opened;
    subscribe(custWs.socket, [`order:${checkout.order.id}`]);
    await Bun.sleep(50);

    const webhookBody = JSON.stringify({ event: "payment.confirmed", gatewayPaymentId: checkout.checkoutReference, gatewayEventId: "rt-e1" });
    const webhookRes = await app.fetch(
      new Request(`${baseUrl}/api/webhooks/payments/testgw`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Webhook-Signature": webhookSignature(webhookBody, "realtime-gateway-secret") },
        body: webhookBody,
      }),
    );
    expect(webhookRes.status).toBe(200);
    expect((await json<{ status: string }>(webhookRes)).status).toBe("confirmed");
    await Bun.sleep(50);
    const afterWebhook = byType(custWs.messages);
    expect(afterWebhook.get("payment.confirmed")?.length).toBe(1);

    const distinct = new Set([...staffWs.messages, ...custWs.messages].map((m) => m.type));
    expect(distinct.size).toBeGreaterThanOrEqual(4);
    for (const required of ["order.confirmed", "invoice.issued", "stock.changed", "payment.confirmed"]) {
      expect(distinct.has(required)).toBe(true);
    }

    const replayBody = JSON.stringify({ event: "payment.confirmed", gatewayPaymentId: checkout.checkoutReference, gatewayEventId: "rt-e1" });
    const replayRes = await app.fetch(
      new Request(`${baseUrl}/api/webhooks/payments/testgw`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Webhook-Signature": webhookSignature(replayBody, "realtime-gateway-secret") },
        body: replayBody,
      }),
    );
    expect(replayRes.status).toBe(200);
    expect((await json<{ status: string }>(replayRes)).status).toBe("replayed");
    await Bun.sleep(50);
    expect(byType(custWs.messages).get("payment.confirmed")?.length).toBe(1);
  });

  test("replay of an idempotent route publishes nothing", async () => {
    const staffWs = wsConnect(staffCookies);
    await staffWs.opened;
    const orderRes = await api(staffCookies, "/api/orders", {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: { orderType: "manual", outletId },
    });
    const order = await json<{ id: string }>(orderRes);
    subscribe(staffWs.socket, [`order:${order.id}`]);
    await Bun.sleep(50);
    const key = randomUUIDv7();
    const confirm = await api(staffCookies, `/api/orders/${order.id}/confirm`, {
      method: "POST",
      idempotencyKey: key,
      body: {},
    });
    expect(confirm.status).toBe(200);
    expect(confirm.headers.get("idempotency-replayed")).toBeNull();
    await Bun.sleep(50);
    const first = byType(staffWs.messages).get("order.confirmed")?.length ?? 0;
    expect(first).toBe(1);
    const replay = await api(staffCookies, `/api/orders/${order.id}/confirm`, {
      method: "POST",
      idempotencyKey: key,
      body: {},
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    await Bun.sleep(50);
    expect(byType(staffWs.messages).get("order.confirmed")?.length).toBe(first);
  });

  test("subscription authorization — customers cannot take order/stock topics they are not entitled to", async () => {
    const custCookies = await signUp("RT Peeker", "peeker@realtime.test", "peeker-pass-1");
    const orderRes = await api(staffCookies, "/api/orders", {
      method: "POST",
      idempotencyKey: randomUUIDv7(),
      body: { orderType: "manual", outletId },
    });
    const otherOrder = await json<{ id: string }>(orderRes);

    const ws = wsConnect(custCookies);
    await ws.opened;
    subscribe(ws.socket, [`order:${otherOrder.id}`]);
    const closeEvent = await Promise.race([ws.closed, Bun.sleep(2000).then(() => null)]);
    expect(closeEvent).not.toBeNull();
    expect((closeEvent as CloseEvent).code).toBe(1008);

    const ws2 = wsConnect(custCookies);
    await ws2.opened;
    subscribe(ws2.socket, [`stock:${outletId}`]);
    const closeEvent2 = await Promise.race([ws2.closed, Bun.sleep(2000).then(() => null)]);
    expect(closeEvent2).not.toBeNull();
    expect((closeEvent2 as CloseEvent).code).toBe(1008);
  });

  test("invalid frames get an error frame; an unauthenticated upgrade is refused", async () => {
    const custCookies = await signUp("RT Talker", "talker@realtime.test", "talker-pass-1");
    const ws = wsConnect(custCookies);
    await ws.opened;
    ws.socket.send(JSON.stringify({ op: "nonsense" }));
    await Bun.sleep(100);
    expect(ws.socket.readyState).toBe(WebSocket.OPEN);
    expect(ws.messages.some((m) => m.type === "hub.error")).toBe(true);
    ws.socket.close();

    const anon = wsConnect(null);
    const outcome = await Promise.race([
      anon.opened.then(() => "opened" as const).catch(() => "error" as const),
      anon.errors.then(() => "error" as const),
      anon.closed.then(() => "closed" as const),
      Bun.sleep(2000).then(() => "timeout" as const),
    ]);
    expect(outcome).not.toBe("opened");
  });
});
