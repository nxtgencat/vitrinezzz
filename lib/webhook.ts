/**
 * Gateway webhook signature verification (`architecture.md` §4.2, `api.md` §7).
 *
 * The gateway sends `X-Webhook-Signature` = lowercase hex HMAC-SHA256 over the
 * **raw request body** (exactly the bytes received, never re-serialized) using
 * the per-gateway secret from `WEBHOOK_SECRET_<GATEWAY>` (the path param,
 * uppercased, non-alphanumerics → `_`). The route verifies before any database
 * access; a missing/unknown secret or a failing comparison is `401`, zero DB
 * reads or writes.
 */
export function webhookSecretFor(gateway: string): string | undefined {
  const normalized = gateway.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return process.env[`WEBHOOK_SECRET_${normalized}`];
}

export function webhookSignature(rawBody: string, secret: string): string {
  const hasher = new Bun.CryptoHasher("sha256", secret);
  hasher.update(rawBody);
  return hasher.digest("hex");
}

export function verifyWebhookSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = webhookSignature(rawBody, secret);
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}