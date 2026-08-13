import { randomUUIDv7 } from "bun";
import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import { auditEvents } from "../db/schema/facts";
import { db } from "../lib/db";
import type { Tx } from "../lib/db";

export const AUDIT_ENTITY_TYPES = [
  "category",
  "product",
  "variant",
  "batch",
  "vendor",
  "outlet",
  "role",
  "staff",
  "settings",
  "media",
] as const;

export const AUDIT_ACTIONS = ["created", "updated", "deactivated", "deleted"] as const;

export type AuditEventInput = {
  entityType: (typeof AUDIT_ENTITY_TYPES)[number];
  entityId: string;
  action: (typeof AUDIT_ACTIONS)[number];
  actorId: string;
  actorType: "staff" | "system";
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
};

/**
 * Appends one `audit_events` row in the same transaction as the mutation it
 * records. `audit_events` is a [FACT] table — insert-only, trigger-protected.
 */
export function writeAuditEvent(tx: Tx, input: AuditEventInput): void {
  tx.insert(auditEvents)
    .values({
      id: randomUUIDv7(),
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      actorId: input.actorId,
      actorType: input.actorType,
      before: input.before,
      after: input.after,
      createdAt: Date.now(),
    })
    .run();
}

export type AuditEventRow = typeof auditEvents.$inferSelect;

export type AuditFilter = {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  from?: number;
  to?: number;
  page: number;
  pageSize: number;
};

/**
 * Read side for `GET /api/audit` (`api.md` §10). Deterministic
 * `(createdAt DESC, id DESC)` — newest first, id tie-break. `from`/`to` are
 * epoch-ms integers.
 */
export function listAuditEvents(filter: AuditFilter): { rows: AuditEventRow[]; total: number } {
  const conditions = [];
  if (filter.entityType) conditions.push(eq(auditEvents.entityType, filter.entityType));
  if (filter.entityId) conditions.push(eq(auditEvents.entityId, filter.entityId));
  if (filter.actorId) conditions.push(eq(auditEvents.actorId, filter.actorId));
  if (filter.from !== undefined) conditions.push(gte(auditEvents.createdAt, filter.from));
  if (filter.to !== undefined) conditions.push(lte(auditEvents.createdAt, filter.to));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const total = db.select({ n: count() }).from(auditEvents).where(where).get()!.n;
  const rows = db
    .select()
    .from(auditEvents)
    .where(where)
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize)
    .all();
  return { rows, total };
}