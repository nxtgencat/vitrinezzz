import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const media = sqliteTable(
  "media",
  {
    id: text("id").primaryKey(),
    ownerType: text("ownerType").notNull(),
    ownerId: text("ownerId").notNull(),
    path: text("path").notNull(),
    thumbPath: text("thumbPath"),
    mimeType: text("mimeType").notNull(),
    sizeBytes: integer("sizeBytes").notNull(),
    altText: text("altText"),
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [index("media_owner_idx").on(t.ownerType, t.ownerId)],
);
