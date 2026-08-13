import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { logger } from "./logger";

export const REASON_CODES = [
  "idempotency_key_required",
  "idempotency_mismatch",
  "insufficient_stock",
  "over_payment",
  "over_return",
  "stale_version",
  "already_issued",
  "invalid_transition",
  "duplicate_batch",
  "duplicate_sku",
  "duplicate_slug",
  "category_cycle",
  "protected_resource",
  "rate_limited",
  "not_found",
  "bad_signature",
  "gateway_unknown",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export type ErrorCode =
  | "VALIDATION"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL";

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: "VALIDATION",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "RATE_LIMITED",
};

const MESSAGE_BY_CODE: Record<ErrorCode, string> = {
  VALIDATION: "validation error",
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not found",
  CONFLICT: "conflict",
  RATE_LIMITED: "rate limited",
  INTERNAL: "internal error",
};

function isReason(message: string): message is ReasonCode {
  return (REASON_CODES as readonly string[]).includes(message);
}

function zodIssues(cause: unknown): unknown[] {
  if (cause && typeof cause === "object" && Array.isArray((cause as { issues?: unknown[] }).issues)) {
    return (cause as { issues: unknown[] }).issues;
  }
  return [];
}

/**
 * `app.onError` — the error envelope for every non-2xx response
 * (`architecture.md` §4.13). Named conditions map to their code; anything else
 * is an INTERNAL 500 with the real error logged, never leaked to the client.
 */
export function handleError(err: Error, c: Context): Response {
  if (err instanceof HTTPException) {
    const code = CODE_BY_STATUS[err.status] ?? "INTERNAL";
    const status = code === "INTERNAL" ? 500 : err.status;
    const message = err.message.length > 0 ? err.message : MESSAGE_BY_CODE[code];
    const reason = isReason(err.message) ? err.message : undefined;
    const details = zodIssues(err.cause);
    return c.json({ error: { code, message, reason, details } }, status);
  }
  const issues = zodIssues(err);
  if (issues.length > 0) {
    return c.json({ error: { code: "VALIDATION", message: MESSAGE_BY_CODE.VALIDATION, reason: undefined, details: issues } }, 400);
  }
  logger.error({ err }, "unhandled error");
  return c.json({ error: { code: "INTERNAL", message: MESSAGE_BY_CODE.INTERNAL, reason: undefined, details: [] } }, 500);
}

export function notFoundHandler(c: Context): Response {
  return c.json({ error: { code: "NOT_FOUND", message: "not found", reason: "not_found", details: [] } }, 404);
}
