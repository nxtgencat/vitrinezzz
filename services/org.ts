import { randomUUIDv7 } from "bun";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, ne } from "drizzle-orm";
import { outlets, roles, settings, staffProfiles } from "../db/schema/org";
import { user } from "../db/schema/auth";
import { db } from "../lib/db";
import type { Tx } from "../lib/db";
import { isCapability } from "../lib/auth";
import { writeAuditEvent } from "./audit";
import { requireCapability } from "./rbac";
import type { StaffActor } from "./rbac";

export type SettingsRow = typeof settings.$inferSelect;
export type OutletRow = typeof outlets.$inferSelect;
export type RoleRow = typeof roles.$inferSelect;
export type StaffProfileRow = typeof staffProfiles.$inferSelect;

export type RoleScope = "global" | "outlet";

/**
 * Org, staff & RBAC domain (`api.md` §2). Every mutating function writes its
 * `audit_events` row in the same transaction as the mutation
 * (`architecture.md` §4.12) and re-asserts `canManageStaff` + outlet scope —
 * never only at the route boundary.
 */

export function getSettings(): SettingsRow | undefined {
  return db.select().from(settings).get();
}

export type UpdateSettingsInput = {
  orgName?: string;
  gstin?: string | null;
  currency?: string;
  timezone?: string;
  fiscalYearStartMonth?: number;
  defaultOutletId?: string | null;
};

/**
 * Upserts the singleton settings row (fixed id `'singleton'`, `schema.md` §8.1).
 * The first write must establish `orgName` + `fiscalYearStartMonth`; `currency`
 * and `timezone` default to `INR` / `Asia/Kolkata`. `defaultOutletId` must point
 * at an active outlet.
 */
export function updateSettings(tx: Tx, actor: StaffActor, input: UpdateSettingsInput): SettingsRow {
  requireCapability(actor, "canManageStaff");
  if (input.defaultOutletId !== undefined && input.defaultOutletId !== null) {
    const outlet = tx.select({ id: outlets.id, isActive: outlets.isActive }).from(outlets).where(eq(outlets.id, input.defaultOutletId)).get();
    if (!outlet) throw new HTTPException(404, { message: "not_found" });
    if (outlet.isActive === 0) throw new HTTPException(409, { message: "invalid_transition" });
  }
  const existing = tx.select().from(settings).get();
  const now = Date.now();
  if (!existing) {
    if (!input.orgName || !input.fiscalYearStartMonth) {
      throw new HTTPException(400, { message: "orgName and fiscalYearStartMonth required on first write" });
    }
    const row: SettingsRow = {
      id: "singleton",
      orgName: input.orgName,
      gstin: input.gstin ?? null,
      fiscalYearStartMonth: input.fiscalYearStartMonth,
      currency: input.currency ?? "INR",
      timezone: input.timezone ?? "Asia/Kolkata",
      defaultOutletId: input.defaultOutletId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    tx.insert(settings).values(row).run();
    writeAuditEvent(tx, {
      entityType: "settings",
      entityId: "singleton",
      action: "created",
      actorId: actor.userId,
      actorType: "staff",
      before: null,
      after: { ...row },
    });
    return row;
  }
  const row: SettingsRow = {
    ...existing,
    orgName: input.orgName ?? existing.orgName,
    gstin: input.gstin !== undefined ? input.gstin : existing.gstin,
    currency: input.currency ?? existing.currency,
    timezone: input.timezone ?? existing.timezone,
    fiscalYearStartMonth: input.fiscalYearStartMonth ?? existing.fiscalYearStartMonth,
    defaultOutletId: input.defaultOutletId !== undefined ? input.defaultOutletId : existing.defaultOutletId,
    updatedAt: now,
  };
  tx.update(settings)
    .set({
      orgName: row.orgName,
      gstin: row.gstin,
      currency: row.currency,
      timezone: row.timezone,
      fiscalYearStartMonth: row.fiscalYearStartMonth,
      defaultOutletId: row.defaultOutletId,
      updatedAt: now,
    })
    .where(eq(settings.id, "singleton"))
    .run();
  writeAuditEvent(tx, {
    entityType: "settings",
    entityId: "singleton",
    action: "updated",
    actorId: actor.userId,
    actorType: "staff",
    before: { ...existing },
    after: { ...row },
  });
  return row;
}

export function listOutlets(filter: { active?: boolean }): OutletRow[] {
  const conditions = [];
  if (filter.active !== undefined) conditions.push(eq(outlets.isActive, filter.active ? 1 : 0));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db.select().from(outlets).where(where).orderBy(asc(outlets.createdAt), asc(outlets.id)).all();
}

export function createOutlet(tx: Tx, actor: StaffActor, input: { name: string }): OutletRow {
  requireCapability(actor, "canManageStaff");
  const now = Date.now();
  const row: OutletRow = { id: randomUUIDv7(), name: input.name, isActive: 1, createdAt: now, updatedAt: now };
  tx.insert(outlets).values(row).run();
  writeAuditEvent(tx, {
    entityType: "outlet",
    entityId: row.id,
    action: "created",
    actorId: actor.userId,
    actorType: "staff",
    before: null,
    after: { ...row },
  });
  return row;
}

export function updateOutlet(
  tx: Tx,
  actor: StaffActor,
  id: string,
  input: { name?: string; isActive?: number },
): OutletRow {
  const target = tx.select().from(outlets).where(eq(outlets.id, id)).get();
  if (!target) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManageStaff", target.id);
  if (input.isActive === 0) {
    const settingsRow = tx.select({ defaultOutletId: settings.defaultOutletId }).from(settings).get();
    if (settingsRow?.defaultOutletId === id) {
      throw new HTTPException(409, { message: "invalid_transition" });
    }
  }
  const now = Date.now();
  const row: OutletRow = {
    ...target,
    name: input.name ?? target.name,
    isActive: input.isActive ?? target.isActive,
    updatedAt: now,
  };
  tx.update(outlets)
    .set({ name: row.name, isActive: row.isActive, updatedAt: now })
    .where(eq(outlets.id, id))
    .run();
  writeAuditEvent(tx, {
    entityType: "outlet",
    entityId: id,
    action: "updated",
    actorId: actor.userId,
    actorType: "staff",
    before: { ...target },
    after: { ...row },
  });
  return row;
}

export function listRoles(filter: { scope?: RoleScope }): RoleRow[] {
  const conditions = [];
  if (filter.scope !== undefined) conditions.push(eq(roles.scope, filter.scope));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db.select().from(roles).where(where).orderBy(asc(roles.createdAt), asc(roles.id)).all();
}

export type RoleInput = {
  name: string;
  capabilities: string[];
  scope: RoleScope;
  outletId?: string | null;
};

function assertRoleInput(tx: Tx, input: RoleInput): string | null {
  for (const capability of input.capabilities) {
    if (!isCapability(capability)) {
      throw new HTTPException(400, { message: "invalid capability" });
    }
  }
  let outletId = input.scope === "outlet" ? (input.outletId ?? null) : null;
  if (input.scope === "outlet" && !outletId) {
    throw new HTTPException(400, { message: "outletId required for outlet scope" });
  }
  if (outletId) {
    const outlet = tx.select({ id: outlets.id }).from(outlets).where(eq(outlets.id, outletId)).get();
    if (!outlet) throw new HTTPException(404, { message: "not_found" });
  }
  return outletId;
}

export function createRole(tx: Tx, actor: StaffActor, input: RoleInput): RoleRow {
  requireCapability(actor, "canManageStaff");
  const outletId = assertRoleInput(tx, input);
  const dup = tx.select({ id: roles.id }).from(roles).where(eq(roles.name, input.name)).get();
  if (dup) throw new HTTPException(409, { message: "duplicate_role" });
  const now = Date.now();
  const row: RoleRow = {
    id: randomUUIDv7(),
    name: input.name,
    capabilities: [...input.capabilities],
    scope: input.scope,
    outletId,
    createdAt: now,
    updatedAt: now,
  };
  try {
    tx.insert(roles).values(row).run();
  } catch (err) {
    if (String(err).includes("UNIQUE constraint failed")) {
      throw new HTTPException(409, { message: "duplicate_role" });
    }
    throw err;
  }
  writeAuditEvent(tx, {
    entityType: "role",
    entityId: row.id,
    action: "created",
    actorId: actor.userId,
    actorType: "staff",
    before: null,
    after: { ...row },
  });
  return row;
}

export function updateRole(tx: Tx, actor: StaffActor, id: string, input: Partial<RoleInput>): RoleRow {
  const target = tx.select().from(roles).where(eq(roles.id, id)).get();
  if (!target) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManageStaff", target.outletId ?? undefined);
  const merged: RoleInput = {
    name: input.name ?? target.name,
    capabilities: input.capabilities ?? target.capabilities,
    scope: input.scope ?? (target.scope as RoleScope),
    outletId: input.outletId !== undefined ? input.outletId : target.outletId,
  };
  const outletId = assertRoleInput(tx, merged);
  if (merged.name !== target.name) {
    const dup = tx.select({ id: roles.id }).from(roles).where(and(eq(roles.name, merged.name), ne(roles.id, id))).get();
    if (dup) throw new HTTPException(409, { message: "duplicate_role" });
  }
  const now = Date.now();
  const row: RoleRow = {
    ...target,
    name: merged.name,
    capabilities: [...merged.capabilities],
    scope: merged.scope,
    outletId,
    updatedAt: now,
  };
  try {
    tx.update(roles)
      .set({ name: row.name, capabilities: row.capabilities, scope: row.scope, outletId: row.outletId, updatedAt: now })
      .where(eq(roles.id, id))
      .run();
  } catch (err) {
    if (String(err).includes("UNIQUE constraint failed")) {
      throw new HTTPException(409, { message: "duplicate_role" });
    }
    throw err;
  }
  writeAuditEvent(tx, {
    entityType: "role",
    entityId: id,
    action: "updated",
    actorId: actor.userId,
    actorType: "staff",
    before: { ...target },
    after: { ...row },
  });
  return row;
}

export type StaffDisplayRow = StaffProfileRow & { name: string; email: string };

export function listStaff(filter: { outletId?: string; roleId?: string; active?: boolean }): StaffDisplayRow[] {
  const conditions = [];
  if (filter.outletId) conditions.push(eq(staffProfiles.outletId, filter.outletId));
  if (filter.roleId) conditions.push(eq(staffProfiles.roleId, filter.roleId));
  if (filter.active !== undefined) conditions.push(eq(staffProfiles.isActive, filter.active ? 1 : 0));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db
    .select({
      id: staffProfiles.id,
      userId: staffProfiles.userId,
      outletId: staffProfiles.outletId,
      roleId: staffProfiles.roleId,
      phone: staffProfiles.phone,
      isActive: staffProfiles.isActive,
      isProtected: staffProfiles.isProtected,
      createdAt: staffProfiles.createdAt,
      updatedAt: staffProfiles.updatedAt,
      name: user.name,
      email: user.email,
    })
    .from(staffProfiles)
    .innerJoin(user, eq(user.id, staffProfiles.userId))
    .where(where)
    .orderBy(asc(staffProfiles.createdAt), asc(staffProfiles.id))
    .all();
}

export type CreateStaffInput = {
  userId: string;
  outletId: string;
  roleId: string;
  phone?: string | null;
};

/**
 * Inserts the staff profile for an auth user the route created beforehand
 * (`POST /api/staff` — better-auth owns the user row and its own transaction,
 * so the profile + audit write is this service's transaction). An outlet-scoped
 * role requires the profile's outlet to equal the role's outlet
 * (`schema.md` §8.4).
 */
export function createStaff(tx: Tx, actor: StaffActor, input: CreateStaffInput): StaffProfileRow {
  requireCapability(actor, "canManageStaff", input.outletId);
  const outlet = tx.select({ id: outlets.id }).from(outlets).where(eq(outlets.id, input.outletId)).get();
  if (!outlet) throw new HTTPException(404, { message: "not_found" });
  const role = tx.select().from(roles).where(eq(roles.id, input.roleId)).get();
  if (!role) throw new HTTPException(404, { message: "not_found" });
  if (role.scope === "outlet" && role.outletId !== input.outletId) {
    throw new HTTPException(400, { message: "outlet mismatch" });
  }
  const now = Date.now();
  const row: StaffProfileRow = {
    id: randomUUIDv7(),
    userId: input.userId,
    outletId: input.outletId,
    roleId: input.roleId,
    phone: input.phone ?? null,
    isActive: 1,
    isProtected: 0,
    createdAt: now,
    updatedAt: now,
  };
  try {
    tx.insert(staffProfiles).values(row).run();
  } catch (err) {
    if (String(err).includes("UNIQUE constraint failed")) {
      throw new HTTPException(409, { message: "duplicate_staff_profile" });
    }
    throw err;
  }
  writeAuditEvent(tx, {
    entityType: "staff",
    entityId: row.id,
    action: "created",
    actorId: actor.userId,
    actorType: "staff",
    before: null,
    after: { ...row },
  });
  return row;
}

export function updateStaff(
  tx: Tx,
  actor: StaffActor,
  id: string,
  input: { outletId?: string; roleId?: string; phone?: string | null; isActive?: number },
): StaffProfileRow {
  const target = tx.select().from(staffProfiles).where(eq(staffProfiles.id, id)).get();
  if (!target) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManageStaff", target.outletId);
  if (input.isActive === 0 && target.isProtected === 1) {
    throw new HTTPException(409, { message: "protected_resource" });
  }
  const outletId = input.outletId ?? target.outletId;
  const roleId = input.roleId ?? target.roleId;
  const outlet = tx.select({ id: outlets.id }).from(outlets).where(eq(outlets.id, outletId)).get();
  if (!outlet) throw new HTTPException(404, { message: "not_found" });
  const role = tx.select().from(roles).where(eq(roles.id, roleId)).get();
  if (!role) throw new HTTPException(404, { message: "not_found" });
  if (role.scope === "outlet" && role.outletId !== outletId) {
    throw new HTTPException(400, { message: "outlet mismatch" });
  }
  const now = Date.now();
  const row: StaffProfileRow = {
    ...target,
    outletId,
    roleId,
    phone: input.phone !== undefined ? input.phone : target.phone,
    isActive: input.isActive ?? target.isActive,
    updatedAt: now,
  };
  tx.update(staffProfiles)
    .set({ outletId, roleId, phone: row.phone, isActive: row.isActive, updatedAt: now })
    .where(eq(staffProfiles.id, id))
    .run();
  writeAuditEvent(tx, {
    entityType: "staff",
    entityId: id,
    action: "updated",
    actorId: actor.userId,
    actorType: "staff",
    before: { ...target },
    after: { ...row },
  });
  return row;
}
