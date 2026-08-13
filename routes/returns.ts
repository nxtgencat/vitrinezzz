import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { respondIdempotent, withIdempotency } from "../lib/idempotency";
import { publish } from "../lib/realtime";
import { jsonValidator, paramValidator, queryValidator } from "../lib/validate";
import { requireCapability, requireStaff } from "../services/rbac";
import { confirmReturn, createReturn, getReturn, listReturns, updateReturn, voidReturn } from "../services/returns";

export const returnsRoutes = new Hono();

const idParam = z.object({ id: z.uuid() });
const returnItemSchema = z
  .object({
    originalItemId: z.uuid(),
    quantity: z.number().int().min(1),
  })
  .strict();

const returnCreateSchema = z
  .object({
    returnType: z.enum(["sales", "purchase"]),
    orderId: z.uuid().nullable().optional(),
    purchaseBillId: z.uuid().nullable().optional(),
    items: z.array(returnItemSchema).min(1),
  })
  .strict();

const returnUpdateSchema = z
  .object({
    items: z.array(returnItemSchema).min(1),
    version: z.number().int().min(1),
  })
  .strict();

returnsRoutes.get(
  "/returns",
  queryValidator(
    z.object({
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(100).optional(),
      returnType: z.enum(["sales", "purchase"]).optional(),
      status: z.enum(["draft", "confirmed", "void"]).optional(),
    }),
  ),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManageReturns");
    const q = c.req.valid("query");
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const { rows, total } = listReturns({
      returnType: q.returnType ?? undefined,
      status: q.status ?? undefined,
      page,
      pageSize,
    });
    return c.json({ data: rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  },
);

returnsRoutes.post("/returns", jsonValidator(returnCreateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageReturns");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => createReturn(tx, actor, body),
  });
  return respondIdempotent(c, result);
});

returnsRoutes.get("/returns/:id", paramValidator(idParam), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageReturns");
  const { id } = c.req.valid("param");
  const ret = getReturn(id);
  if (!ret) throw new HTTPException(404, { message: "not_found" });
  return c.json(ret);
});

returnsRoutes.put("/returns/:id", paramValidator(idParam), jsonValidator(returnUpdateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageReturns");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => updateReturn(tx, actor, id, body),
  });
  return respondIdempotent(c, result);
});

returnsRoutes.post("/returns/:id/confirm", paramValidator(idParam), jsonValidator(z.object({})), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageReturns");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => confirmReturn(tx, actor, id),
  });
  if (!result.replayed && result.value) {
    const ret = result.value as ReturnType<typeof confirmReturn>;
    if (ret.orderId) {
      publish("order:" + ret.orderId, "return.confirmed", ret.orderId);
    }
    publish("stock:" + ret.outletId, "stock.changed", ret.outletId);
  }
  return respondIdempotent(c, result);
});

returnsRoutes.post("/returns/:id/void", paramValidator(idParam), jsonValidator(z.object({})), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageReturns");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => voidReturn(tx, actor, id),
  });
  return respondIdempotent(c, result);
});