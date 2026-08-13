import { Hono } from "hono";
import { z } from "zod";
import { respondIdempotent, withIdempotency } from "../lib/idempotency";
import { jsonValidator, queryValidator } from "../lib/validate";
import { requireCapability, requireStaff } from "../services/rbac";
import { listPayments, recordPayment } from "../services/payments";

export const paymentsRoutes = new Hono();

const paymentCreateSchema = z.object({
  direction: z.enum(["in", "out"]),
  partyType: z.enum(["customer", "vendor"]),
  partyId: z.uuid(),
  invoiceId: z.uuid().nullable().optional(),
  purchaseBillId: z.uuid().nullable().optional(),
  returnId: z.uuid().nullable().optional(),
  amountPaise: z.number().int().min(1),
  mode: z.enum(["cash", "upi", "card", "bank"]),
  outletId: z.uuid(),
});

paymentsRoutes.get(
  "/payments",
  queryValidator(
    z.object({
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(100).optional(),
      direction: z.enum(["in", "out"]).optional(),
      partyType: z.enum(["customer", "vendor"]).optional(),
      partyId: z.uuid().optional(),
      from: z.coerce.number().int().optional(),
      to: z.coerce.number().int().optional(),
    }),
  ),
  async (c) => {
    const actor = await requireStaff(c.req.raw.headers);
    requireCapability(actor, "canManagePayments");
    const q = c.req.valid("query");
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const { rows, total } = listPayments({
      direction: q.direction ?? undefined,
      partyType: q.partyType ?? undefined,
      partyId: q.partyId ?? undefined,
      from: q.from ?? undefined,
      to: q.to ?? undefined,
      page,
      pageSize,
    });
    return c.json({ data: rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  },
);

paymentsRoutes.post("/payments", jsonValidator(paymentCreateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManagePayments");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => recordPayment(tx, actor, body),
  });
  return respondIdempotent(c, result);
});