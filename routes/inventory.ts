import { Hono } from "hono";
import { z } from "zod";
import { respondIdempotent, withIdempotency } from "../lib/idempotency";
import { jsonValidator, queryValidator } from "../lib/validate";
import { requireCapability, requireStaff } from "../services/rbac";
import { createBatch, listStockLevels } from "../services/stock";

export const inventoryRoutes = new Hono();

const batchCreateSchema = z.object({
  variantId: z.uuid(),
  batchNumber: z.string().trim().min(1).max(100),
  expiryDate: z.number().int().positive().nullable().optional(),
  costPricePaise: z.number().int().min(0),
});

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