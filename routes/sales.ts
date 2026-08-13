import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { respondIdempotent, withIdempotency } from "../lib/idempotency";
import { jsonValidator, paramValidator, queryValidator } from "../lib/validate";
import { requireCapability, requireStaff } from "../services/rbac";
import {
  cancelOrder,
  confirmOrder,
  createOrder,
  getInvoice,
  getOrder,
  issueInvoice,
  listInvoices,
  listOrders,
  posCheckout,
  updateInvoice,
  updateOrder,
  voidInvoice,
} from "../services/sales";

export const salesRoutes = new Hono();

const paise = z.number().int().min(0);
const idParam = z.object({ id: z.uuid() });
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

const orderCreateSchema = z.object({
  orderType: z.enum(["pos", "manual"]),
  customerId: z.uuid().nullable().optional(),
  outletId: z.uuid(),
});

const orderUpdateSchema = orderCreateSchema.extend({
  version: z.number().int().min(1),
});

const saleLineSchema = z.union([
  z
    .object({
      variantId: z.uuid(),
      quantity: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      isCustomItem: z.literal(true),
      name: z.string().trim().min(1).max(200),
      quantity: z.number().int().min(1),
      unitPricePaise: paise,
    })
    .strict(),
]);

const saleChargeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  amountPaise: z.number().int(),
});

const invoiceUpdateSchema = z.object({
  items: z.array(saleLineSchema).min(1),
  charges: z.array(saleChargeSchema).optional(),
  version: z.number().int().min(1),
});

const posCheckoutSchema = z.object({
  customerId: z.uuid().nullable().optional(),
  outletId: z.uuid(),
  items: z.array(saleLineSchema).min(1),
  charges: z.array(saleChargeSchema).optional(),
});

salesRoutes.get("/orders", queryValidator(pageQuery), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageSales");
  const q = c.req.valid("query");
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 25;
  const { rows, total } = listOrders({ page, pageSize });
  return c.json({ data: rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
});

salesRoutes.post("/orders", jsonValidator(orderCreateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageSales");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => createOrder(tx, actor, body),
  });
  return respondIdempotent(c, result);
});

salesRoutes.get("/orders/:id", paramValidator(idParam), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageSales");
  const { id } = c.req.valid("param");
  const order = getOrder(id);
  if (!order) throw new HTTPException(404, { message: "not_found" });
  return c.json(order);
});

salesRoutes.put("/orders/:id", paramValidator(idParam), jsonValidator(orderUpdateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageSales");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => updateOrder(tx, actor, id, body),
  });
  return respondIdempotent(c, result);
});

salesRoutes.post("/orders/:id/confirm", paramValidator(idParam), jsonValidator(z.object({})), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageSales");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => confirmOrder(tx, actor, id),
  });
  return respondIdempotent(c, result);
});

salesRoutes.post("/orders/:id/cancel", paramValidator(idParam), jsonValidator(z.object({})), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageSales");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => cancelOrder(tx, actor, id),
  });
  return respondIdempotent(c, result);
});

salesRoutes.get("/invoices", queryValidator(pageQuery), async (c) => {
  await requireStaff(c.req.raw.headers);
  const q = c.req.valid("query");
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 25;
  const { rows, total } = listInvoices({ page, pageSize });
  return c.json({ data: rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
});

salesRoutes.get("/invoices/:id", paramValidator(idParam), async (c) => {
  await requireStaff(c.req.raw.headers);
  const { id } = c.req.valid("param");
  const invoice = getInvoice(id);
  if (!invoice) throw new HTTPException(404, { message: "not_found" });
  return c.json(invoice);
});

salesRoutes.put("/invoices/:id", paramValidator(idParam), jsonValidator(invoiceUpdateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => updateInvoice(tx, actor, id, body),
  });
  return respondIdempotent(c, result);
});

salesRoutes.post("/invoices/:id/issue", paramValidator(idParam), jsonValidator(z.object({})), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageSales");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => issueInvoice(tx, actor, id),
  });
  return respondIdempotent(c, result);
});

salesRoutes.post("/invoices/:id/void", paramValidator(idParam), jsonValidator(z.object({})), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageSales");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => voidInvoice(tx, actor, id),
  });
  return respondIdempotent(c, result);
});

salesRoutes.post("/sales/pos/checkout", jsonValidator(posCheckoutSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageSales");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => posCheckout(tx, actor, body),
  });
  return respondIdempotent(c, result);
});
