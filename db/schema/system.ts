import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    id: text("id").primaryKey(),
    operation: text("operation").notNull(),
    key: text("key").notNull(),
    requestHash: text("requestHash").notNull(),
    responseSnapshot: text("responseSnapshot", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(),
    createdAt: integer("createdAt").notNull(),
    expiresAt: integer("expiresAt").notNull(),
  },
  (t) => [
    uniqueIndex("idempotency_keys_operation_key_unique").on(t.operation, t.key),
    index("idempotency_keys_expires_idx").on(t.expiresAt),
  ],
);
