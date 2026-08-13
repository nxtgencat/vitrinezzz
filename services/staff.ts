import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { staffProfiles } from "../db/schema/org";
import type { Tx } from "../lib/db";
import { writeAuditEvent } from "./audit";
import { requireCapability } from "./rbac";
import type { StaffActor } from "./rbac";

/**
 * Soft-deletes a staff profile. The protected bootstrap admin is undeletable —
 * `409 protected_resource`. Outlet-scoped `canManageStaff` roles may only
 * deactivate profiles in their own outlet.
 */
export function deactivateStaffProfile(tx: Tx, actor: StaffActor, targetProfileId: string): void {
  const target = tx
    .select()
    .from(staffProfiles)
    .where(eq(staffProfiles.id, targetProfileId))
    .get();
  if (!target) throw new HTTPException(404, { message: "not_found" });
  requireCapability(actor, "canManageStaff", target.outletId);
  if (target.isProtected === 1) {
    throw new HTTPException(409, { message: "protected_resource" });
  }
  const now = Date.now();
  const before = { ...target };
  const after = { ...target, isActive: 0, updatedAt: now };
  tx.update(staffProfiles)
    .set({ isActive: 0, updatedAt: now })
    .where(eq(staffProfiles.id, targetProfileId))
    .run();
  writeAuditEvent(tx, {
    entityType: "staff",
    entityId: targetProfileId,
    action: "deactivated",
    actorId: actor.userId,
    actorType: "staff",
    before,
    after,
  });
}