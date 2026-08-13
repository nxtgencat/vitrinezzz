import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { respondIdempotent, withIdempotency } from "../lib/idempotency";
import { jsonValidator, paramValidator, queryValidator } from "../lib/validate";
import { requireCapability, requireStaff } from "../services/rbac";
import { createShipment, deliverShipment, dispatchShipment, getShipment, listShipments, updateShipment } from "../services/fulfillment";

export const fulfillmentRoutes = new Hono();

const idParam = z.object({ id: z.uuid() });

const shipmentCreateSchema = z
  .object({
    invoiceId: z.uuid(),
    carrier: z.string().trim().min(1).max(200),
    awbNumber: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict();

const shipmentUpdateSchema = z
  .object({
    carrier: z.string().trim().min(1).max(200),
    awbNumber: z.string().trim().min(1).max(100).nullable().optional(),
    version: z.number().int().min(1),
  })
  .strict();

fulfillmentRoutes.get(
  "/shipments",
  queryValidator(
    z.object({
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(100).optional(),
      status: z.enum(["created", "dispatched", "delivered"]).optional(),
    }),
  ),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManageFulfillment");
    const q = c.req.valid("query");
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const { rows, total } = listShipments({ status: q.status ?? undefined, page, pageSize });
    return c.json({ data: rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  },
);

fulfillmentRoutes.post("/shipments", jsonValidator(shipmentCreateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageFulfillment");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => createShipment(tx, actor, body),
  });
  return respondIdempotent(c, result);
});

fulfillmentRoutes.get("/shipments/:id", paramValidator(idParam), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageFulfillment");
  const { id } = c.req.valid("param");
  const shipment = getShipment(id);
  if (!shipment) throw new HTTPException(404, { message: "not_found" });
  return c.json(shipment);
});

fulfillmentRoutes.put("/shipments/:id", paramValidator(idParam), jsonValidator(shipmentUpdateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageFulfillment");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => updateShipment(tx, actor, id, body),
  });
  return respondIdempotent(c, result);
});

fulfillmentRoutes.post("/shipments/:id/dispatch", paramValidator(idParam), jsonValidator(z.object({})), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageFulfillment");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => dispatchShipment(tx, actor, id),
  });
  return respondIdempotent(c, result);
});

fulfillmentRoutes.post("/shipments/:id/deliver", paramValidator(idParam), jsonValidator(z.object({})), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageFulfillment");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => deliverShipment(tx, actor, id),
  });
  return respondIdempotent(c, result);
});