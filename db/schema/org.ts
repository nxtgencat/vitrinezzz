import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth";

export const outlets = sqliteTable("outlets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  isActive: integer("isActive").notNull(),
  createdAt: integer("createdAt").notNull(),
  updatedAt: integer("updatedAt").notNull(),
});

export const settings = sqliteTable(
  "settings",
  {
    id: text("id").primaryKey(),
    orgName: text("orgName").notNull(),
    gstin: text("gstin"),
    fiscalYearStartMonth: integer("fiscalYearStartMonth").notNull(),
    currency: text("currency").notNull(),
    timezone: text("timezone").notNull(),
    defaultOutletId: text("defaultOutletId").references(() => outlets.id, { onDelete: "restrict" }),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
);

export const roles = sqliteTable(
  "roles",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    capabilities: text("capabilities", { mode: "json" }).$type<string[]>().notNull(),
    scope: text("scope").notNull(),
    outletId: text("outletId").references(() => outlets.id, { onDelete: "restrict" }),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [
    uniqueIndex("roles_name_unique").on(t.name),
    index("roles_scope_idx").on(t.scope),
  ],
);

export const staffProfiles = sqliteTable(
  "staff_profiles",
  {
    id: text("id").primaryKey(),
    userId: text("userId").references(() => user.id, { onDelete: "restrict" }).notNull(),
    outletId: text("outletId").references(() => outlets.id, { onDelete: "restrict" }).notNull(),
    roleId: text("roleId").references(() => roles.id, { onDelete: "restrict" }).notNull(),
    phone: text("phone"),
    isActive: integer("isActive").notNull(),
    isProtected: integer("isProtected").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (t) => [uniqueIndex("staff_profiles_user_id_unique").on(t.userId)],
);
