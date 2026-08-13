import { Hono } from "hono";
import { z } from "zod";
import { queryValidator } from "../lib/validate";
import { requireCapability, requireStaff } from "../services/rbac";
import { AUDIT_ENTITY_TYPES, listAuditEvents } from "../services/audit";

export const auditRoutes = new Hono();

const auditQuery = z.object({
  entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
  entityId: z.uuid().optional(),
  actorId: z.uuid().optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

auditRoutes.get("/audit", queryValidator(auditQuery), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageStaff");
  const q = c.req.valid("query");
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 25;
  const { rows, total } = listAuditEvents({
    entityType: q.entityType,
    entityId: q.entityId,
    actorId: q.actorId,
    from: q.from,
    to: q.to,
    page,
    pageSize,
  });
  return c.json({ data: rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
});