import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { invoices } from "../db/schema/orders";
import { db } from "../lib/db";
import { withTx } from "../lib/db";
import { publish } from "../lib/realtime";
import { verifyWebhookSignature, webhookSecretFor } from "../lib/webhook";
import { confirmGatewayPayment } from "../services/payments";

export const webhookRoutes = new Hono();

/**
 * Webhook payload (`api.md` §7): the gateway's own event id (`gatewayEventId`)
 * is the dedupe key; `gatewayPaymentId` is the checkout reference the
 * storefront checkout returned. **No money field exists** — the confirmed
 * payment's amount is derived server-side from the pending checkout row.
 */
const webhookBodySchema = z
  .object({
    event: z.literal("payment.confirmed"),
    gatewayPaymentId: z.string().trim().min(1).max(200),
    gatewayEventId: z.string().trim().min(1).max(200),
  })
  .strict();

/**
 * `POST /api/webhooks/payments/:gateway` — the sanctioned idempotency
 * exception (`architecture.md` §4.2): signature-verified before any DB access
 * (401 on bad/missing signature or unknown gateway, zero reads or writes),
 * then deduped on `UNIQUE(gateway, gatewayEventId)` (R7) — a replay or racing
 * duplicate returns `200` with zero side effects. No staff actor exists in
 * this request; the routine it runs is the zero-capability payment-confirm
 * path (`architecture.md` §4.14).
 */
webhookRoutes.post("/webhooks/payments/:gateway", async (c) => {
  const gateway = c.req.param("gateway");
  const secret = webhookSecretFor(gateway);
  if (!secret) {
    throw new HTTPException(401, { message: "gateway_unknown" });
  }
  const rawBody = await c.req.text();
  const signature = c.req.header("X-Webhook-Signature");
  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    throw new HTTPException(401, { message: "bad_signature" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new HTTPException(400, { message: "invalid JSON" });
  }
  const body = webhookBodySchema.parse(parsed);
  const result = await withTx((tx) => confirmGatewayPayment(tx, { gateway, ...body }));
  if (result.status === "confirmed" && result.orderId && result.invoiceId) {
    publish("order:" + result.orderId, "payment.confirmed", result.orderId);
    publish("invoice:" + result.invoiceId, "invoice.issued", result.invoiceId);
    const outletId = db.select({ outletId: invoices.outletId }).from(invoices).where(eq(invoices.id, result.invoiceId)).get()?.outletId;
    if (outletId) {
      publish("stock:" + outletId, "stock.changed", outletId);
    }
  } else if (result.status === "refunded" && result.orderId) {
    publish("order:" + result.orderId, "payment.refunded", result.orderId);
  }
  return c.json(result);
});