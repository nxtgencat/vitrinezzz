import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { respondIdempotent, withIdempotency } from "../lib/idempotency";
import { jsonValidator, paramValidator, queryValidator } from "../lib/validate";
import { requireCapability, requireStaff } from "../services/rbac";
import { createBill, createVendor, getBill, issueBill, listBills, listVendors, updateBill, voidBill } from "../services/purchasing";

export const purchasingRoutes = new Hono();

const paise = z.number().int().min(0);
const idParam = z.object({ id: z.uuid() });

const vendorCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(1).max(50),
  gstin: z.string().trim().min(1).max(50).nullable().optional(),
});

const billLineSchema = z.object({
  variantId: z.uuid(),
  batchNumber: z.string().trim().min(1).max(100).nullable().optional(),
  quantity: z.number().int().min(1),
  unitCostPaise: paise,
  taxRatePct: z.number().int().min(0).max(100),
});

const billChargeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  amountPaise: z.number().int(),
});

const billCreateSchema = z.object({
  vendorId: z.uuid(),
  outletId: z.uuid(),
  items: z.array(billLineSchema).min(1),
  charges: z.array(billChargeSchema).optional(),
});

const billUpdateSchema = billCreateSchema.extend({
  version: z.number().int().min(1),
});

purchasingRoutes.get(
  "/vendors",
  queryValidator(z.object({ page: z.coerce.number().int().min(1).optional(), pageSize: z.coerce.number().int().min(1).max(100).optional() })),
  async (c) => {
    await requireStaff(c.req.raw.headers);
    const q = c.req.valid("query");
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const { rows, total } = listVendors({ page, pageSize });
    return c.json({ data: rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  },
);

purchasingRoutes.post("/vendors", jsonValidator(vendorCreateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManagePurchases");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => createVendor(tx, actor, body),
  });
  return respondIdempotent(c, result);
});

purchasingRoutes.get(
  "/purchase-bills",
  queryValidator(z.object({ page: z.coerce.number().int().min(1).optional(), pageSize: z.coerce.number().int().min(1).max(100).optional() })),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManagePurchases");
    const q = c.req.valid("query");
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const { rows, total } = listBills({ page, pageSize });
    return c.json({ data: rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  },
);

purchasingRoutes.post("/purchase-bills", jsonValidator(billCreateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManagePurchases");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => createBill(tx, actor, body),
  });
  return respondIdempotent(c, result);
});

purchasingRoutes.get("/purchase-bills/:id", paramValidator(idParam), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManagePurchases");
  const { id } = c.req.valid("param");
  const bill = getBill(id);
  if (!bill) throw new HTTPException(404, { message: "not_found" });
  return c.json(bill);
});

purchasingRoutes.put(
  "/purchase-bills/:id",
  paramValidator(idParam),
  jsonValidator(billUpdateSchema),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManagePurchases");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const key = c.req.header("Idempotency-Key");
    const result = await withIdempotency({
      operation: `${c.req.method} ${c.req.routePath}`,
      key,
      actorId: actor.userId,
      body,
      run: (tx) => updateBill(tx, actor, id, body),
    });
    return respondIdempotent(c, result);
  },
);

purchasingRoutes.post(
  "/purchase-bills/:id/issue",
  paramValidator(idParam),
  jsonValidator(z.object({})),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManagePurchases");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const key = c.req.header("Idempotency-Key");
    const result = await withIdempotency({
      operation: `${c.req.method} ${c.req.routePath}`,
      key,
      actorId: actor.userId,
      body,
      run: (tx) => issueBill(tx, actor, id),
    });
    return respondIdempotent(c, result);
  },
);

purchasingRoutes.post(
  "/purchase-bills/:id/void",
  paramValidator(idParam),
  jsonValidator(z.object({})),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManagePurchases");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const key = c.req.header("Idempotency-Key");
    const result = await withIdempotency({
      operation: `${c.req.method} ${c.req.routePath}`,
      key,
      actorId: actor.userId,
      body,
      run: (tx) => voidBill(tx, actor, id),
    });
    return respondIdempotent(c, result);
  },
);