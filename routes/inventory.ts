import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { respondIdempotent, withIdempotency } from "../lib/idempotency";
import { jsonValidator, paramValidator, queryValidator } from "../lib/validate";
import { requireCapability, requireStaff } from "../services/rbac";
import { createBatch, listStockLevels } from "../services/stock";
import {
  confirmAdjustment,
  confirmTransfer,
  createAdjustment,
  createTransfer,
  getAdjustment,
  getTransfer,
  listAdjustments,
  listTransfers,
  updateAdjustment,
  updateTransfer,
  voidAdjustment,
  voidTransfer,
} from "../services/inventory";

export const inventoryRoutes = new Hono();

const batchCreateSchema = z.object({
  variantId: z.uuid(),
  batchNumber: z.string().trim().min(1).max(100),
  expiryDate: z.number().int().positive().nullable().optional(),
  costPricePaise: z.number().int().min(0),
});

const statusQuery = z.enum(["draft", "confirmed", "void"]).optional();

const transferLineSchema = z.object({
  variantId: z.uuid(),
  batchId: z.uuid(),
  quantity: z.number().int().min(1),
});

const transferCreateSchema = z.object({
  fromOutletId: z.uuid(),
  toOutletId: z.uuid(),
  items: z.array(transferLineSchema).min(1),
});

const transferUpdateSchema = transferCreateSchema.extend({
  version: z.number().int().min(1),
});

const adjustmentLineSchema = z.object({
  variantId: z.uuid(),
  batchId: z.uuid(),
  quantity: z.number().int().refine((q) => q !== 0, { message: "quantity must be non-zero" }),
});

const adjustmentCreateSchema = z.object({
  outletId: z.uuid(),
  reason: z.string().trim().min(1).max(200),
  items: z.array(adjustmentLineSchema).min(1),
});

const adjustmentUpdateSchema = adjustmentCreateSchema.extend({
  version: z.number().int().min(1),
});

const idParam = z.object({ id: z.uuid() });

inventoryRoutes.post("/inventory/batches", jsonValidator(batchCreateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageInventory");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => createBatch(tx, actor, body),
  });
  return respondIdempotent(c, result);
});

inventoryRoutes.get(
  "/inventory/stock-levels",
  queryValidator(
    z.object({
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(100).optional(),
      outletId: z.uuid().optional(),
      variantId: z.uuid().optional(),
      lowStock: z.coerce.number().int().min(0).optional(),
    }),
  ),
  async (c) => {
    await requireStaff(c.req.raw.headers);
    const q = c.req.valid("query");
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const { rows, total } = listStockLevels({
      outletId: q.outletId ?? undefined,
      variantId: q.variantId ?? undefined,
      lowStock: q.lowStock ?? undefined,
      page,
      pageSize,
    });
    return c.json({
      data: rows,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  },
);

function pagination(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

inventoryRoutes.get(
  "/inventory/transfers",
  queryValidator(
    z.object({
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(100).optional(),
      status: statusQuery,
    }),
  ),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManageInventory");
    const q = c.req.valid("query");
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const { rows, total } = listTransfers({ status: q.status ?? undefined, page, pageSize });
    return c.json({ data: rows, pagination: pagination(page, pageSize, total) });
  },
);

inventoryRoutes.post("/inventory/transfers", jsonValidator(transferCreateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageInventory");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => createTransfer(tx, actor, body),
  });
  return respondIdempotent(c, result);
});

inventoryRoutes.get("/inventory/transfers/:id", paramValidator(idParam), async (c) => {
  await requireStaff(c.req.raw.headers);
  const { id } = c.req.valid("param");
  const transfer = getTransfer(id);
  if (!transfer) throw new HTTPException(404, { message: "not_found" });
  return c.json(transfer);
});

inventoryRoutes.put(
  "/inventory/transfers/:id",
  paramValidator(idParam),
  jsonValidator(transferUpdateSchema),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManageInventory");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const key = c.req.header("Idempotency-Key");
    const result = await withIdempotency({
      operation: `${c.req.method} ${c.req.routePath}`,
      key,
      actorId: actor.userId,
      body,
      run: (tx) => updateTransfer(tx, actor, id, body),
    });
    return respondIdempotent(c, result);
  },
);

inventoryRoutes.post(
  "/inventory/transfers/:id/confirm",
  paramValidator(idParam),
  jsonValidator(z.object({})),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManageInventory");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const key = c.req.header("Idempotency-Key");
    const result = await withIdempotency({
      operation: `${c.req.method} ${c.req.routePath}`,
      key,
      actorId: actor.userId,
      body,
      run: (tx) => confirmTransfer(tx, actor, id),
    });
    return respondIdempotent(c, result);
  },
);

inventoryRoutes.post(
  "/inventory/transfers/:id/void",
  paramValidator(idParam),
  jsonValidator(z.object({})),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManageInventory");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const key = c.req.header("Idempotency-Key");
    const result = await withIdempotency({
      operation: `${c.req.method} ${c.req.routePath}`,
      key,
      actorId: actor.userId,
      body,
      run: (tx) => voidTransfer(tx, actor, id),
    });
    return respondIdempotent(c, result);
  },
);

inventoryRoutes.get(
  "/inventory/adjustments",
  queryValidator(
    z.object({
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(100).optional(),
      status: statusQuery,
    }),
  ),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManageInventory");
    const q = c.req.valid("query");
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const { rows, total } = listAdjustments({ status: q.status ?? undefined, page, pageSize });
    return c.json({ data: rows, pagination: pagination(page, pageSize, total) });
  },
);

inventoryRoutes.post("/inventory/adjustments", jsonValidator(adjustmentCreateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageInventory");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => createAdjustment(tx, actor, body),
  });
  return respondIdempotent(c, result);
});

inventoryRoutes.get("/inventory/adjustments/:id", paramValidator(idParam), async (c) => {
  await requireStaff(c.req.raw.headers);
  const { id } = c.req.valid("param");
  const adjustment = getAdjustment(id);
  if (!adjustment) throw new HTTPException(404, { message: "not_found" });
  return c.json(adjustment);
});

inventoryRoutes.put(
  "/inventory/adjustments/:id",
  paramValidator(idParam),
  jsonValidator(adjustmentUpdateSchema),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManageInventory");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const key = c.req.header("Idempotency-Key");
    const result = await withIdempotency({
      operation: `${c.req.method} ${c.req.routePath}`,
      key,
      actorId: actor.userId,
      body,
      run: (tx) => updateAdjustment(tx, actor, id, body),
    });
    return respondIdempotent(c, result);
  },
);

inventoryRoutes.post(
  "/inventory/adjustments/:id/confirm",
  paramValidator(idParam),
  jsonValidator(z.object({})),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManageInventory");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const key = c.req.header("Idempotency-Key");
    const result = await withIdempotency({
      operation: `${c.req.method} ${c.req.routePath}`,
      key,
      actorId: actor.userId,
      body,
      run: (tx) => confirmAdjustment(tx, actor, id),
    });
    return respondIdempotent(c, result);
  },
);

inventoryRoutes.post(
  "/inventory/adjustments/:id/void",
  paramValidator(idParam),
  jsonValidator(z.object({})),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManageInventory");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const key = c.req.header("Idempotency-Key");
    const result = await withIdempotency({
      operation: `${c.req.method} ${c.req.routePath}`,
      key,
      actorId: actor.userId,
      body,
      run: (tx) => voidAdjustment(tx, actor, id),
    });
    return respondIdempotent(c, result);
  },
);