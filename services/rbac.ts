import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { isCapability } from "../lib/auth";
import type { Capability } from "../lib/auth";
import { auth } from "../lib/auth";
import { db } from "../lib/db";
import { customers } from "../db/schema/catalog";
import { roles, staffProfiles } from "../db/schema/org";

export type StaffActor = {
  userId: string;
  staffProfileId: string;
  outletId: string;
  roleId: string;
  roleScope: "global" | "outlet";
  capabilities: Capability[];
};

export type CustomerActor = {
  userId: string;
  customerId: string;
  name: string;
};

/**
 * Route-boundary guard: a valid session is required (401), and the session's user
 * must have an active staff profile with a resolvable role (403 — an authenticated
 * user without a staff profile is a normal state, a customer, not a server error).
 */
export async function requireStaff(headers: Headers): Promise<StaffActor> {
  const session = await auth.api.getSession({ headers });
  if (!session) throw new HTTPException(401, { message: "unauthorized" });
  const profile = db
    .select()
    .from(staffProfiles)
    .where(eq(staffProfiles.userId, session.user.id))
    .get();
  if (!profile || profile.isActive === 0) {
    throw new HTTPException(403, { message: "not a staff member" });
  }
  const role = db.select().from(roles).where(eq(roles.id, profile.roleId)).get();
  if (!role) throw new HTTPException(403, { message: "no role assigned" });
  if (role.scope === "outlet" && role.outletId !== profile.outletId) {
    throw new HTTPException(403, { message: "role outlet mismatch" });
  }
  return {
    userId: session.user.id,
    staffProfileId: profile.id,
    outletId: profile.outletId,
    roleId: role.id,
    roleScope: role.scope === "outlet" ? "outlet" : "global",
    capabilities: role.capabilities.filter(isCapability),
  };
}

/**
 * Route-boundary guard: a valid session is required (401), and the session's user
 * must have an active customer profile (403). Profiles are auto-provisioned by the
 * better-auth `user.create.after` hook, so this only fails on a stale or
 * deactivated profile.
 */
export async function requireCustomer(headers: Headers): Promise<CustomerActor> {
  const session = await auth.api.getSession({ headers });
  if (!session) throw new HTTPException(401, { message: "unauthorized" });
  const profile = db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .get();
  if (!profile || profile.isActive === 0) {
    throw new HTTPException(403, { message: "not a customer" });
  }
  return { userId: session.user.id, customerId: profile.id, name: profile.name };
}

/**
 * Service-layer capability gate — asserted at the top of every gated service
 * function, never only at the route. `scopedOutletId` declares which outlet the
 * operation touches; an outlet-scoped role may only act on its own profile's
 * outlet, and operations that declare no outlet scope are denied to outlet-scoped
 * actors entirely (an outlet-scoped role's effective reach is exactly one outlet).
 */
export function requireCapability(actor: StaffActor, cap: Capability, scopedOutletId?: string): void {
  if (!actor.capabilities.includes(cap)) {
    throw new HTTPException(403, { message: "missing capability" });
  }
  if (actor.roleScope === "outlet" && scopedOutletId !== actor.outletId) {
    throw new HTTPException(403, { message: "outside outlet scope" });
  }
}