import { randomUUIDv7 } from "bun";
import { auditEvents } from "../db/schema/facts";
import type { Tx } from "../lib/db";

export const AUDIT_ENTITY_TYPES = [
  "category",
  "product",
  "variant",
  "batch",
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