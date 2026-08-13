import {
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { orders } from "./orders";

export const orderEvents = sqliteTable(
  "order_events",
  {
    id: text("id").primaryKey(),
    orderId: text("orderId").references(() => orders.id, { onDelete: "restrict" }).notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    actorId: text("actorId"),
    actorType: text("actorType").notNull(),
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [index("order_events_order_idx").on(t.orderId, t.createdAt)],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    entityType: text("entityType").notNull(),
    entityId: text("entityId").notNull(),
    action: text("action").notNull(),
    actorId: text("actorId").notNull(),
    actorType: text("actorType").notNull(),
    before: text("before", { mode: "json" }).$type<Record<string, unknown> | null>(),
    after: text("after", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [
    index("audit_events_entity_idx").on(t.entityType, t.entityId),
    index("audit_events_actor_idx").on(t.actorId),
  ],
);
