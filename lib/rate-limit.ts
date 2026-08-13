import { HTTPException } from "hono/http-exception";

/**
 * Minimal in-process fixed-window rate limiter (`api.md` §9 — checkout is
 * "rate-limited 5/min"). Per-key window in memory; not distributed, which is
 * fine for a single-instance deployment — the honest failure mode of a
 * multi-instance deploy is a slightly higher effective limit, never a bypass
 * of the business rules. The REASON_CODE `rate_limited` maps to 429.
 */
const windows = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const entry = windows.get(key);
  if (!entry || entry.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  entry.count += 1;
  if (entry.count > limit) {
    throw new HTTPException(429, { message: "rate_limited" });
  }
}
