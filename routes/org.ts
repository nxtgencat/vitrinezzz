import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { ALL_CAPABILITIES, auth } from "../lib/auth";
import { user } from "../db/schema/auth";
import { idempotencyKeys } from "../db/schema/system";
import { db } from "../lib/db";
import { respondIdempotent, withIdempotency } from "../lib/idempotency";
import { jsonValidator, paramValidator, queryValidator } from "../lib/validate";
import { requireCapability, requireStaff } from "../services/rbac";
import {
  createOutlet,
  createRole,
  createStaff,
  getSettings,
  listOutlets,
  listRoles,
  listStaff,
  updateOutlet,
  updateRole,
  updateSettings,
  updateStaff,
} from "../services/org";
import { deactivateStaffProfile } from "../services/staff";

export const orgRoutes = new Hono();

const settingsSchema = z
  .object({
    orgName: z.string().trim().min(1).max(200).optional(),
    gstin: z.string().trim().max(30).nullable().optional(),
    currency: z.string().trim().min(3).max(3).optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
    defaultOutletId: z.uuid().nullable().optional(),
  })
  .strict();

const outletCreateSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();

const outletUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    isActive: z.number().int().min(0).max(1).optional(),
  })
  .strict();

const roleCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    capabilities: z.array(z.enum(ALL_CAPABILITIES)).min(1),
    scope: z.enum(["global", "outlet"]),
    outletId: z.uuid().nullable().optional(),
  })
  .strict();

const roleUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    capabilities: z.array(z.enum(ALL_CAPABILITIES)).min(1).optional(),
    scope: z.enum(["global", "outlet"]).optional(),
    outletId: z.uuid().nullable().optional(),
  })
  .strict();

const staffCreateSchema = z
  .object({
    email: z.email(),
    password: z.string().min(8).max(200),
    name: z.string().trim().min(1).max(200),
    outletId: z.uuid(),
    roleId: z.uuid(),
    phone: z.string().trim().max(20).optional(),
  })
  .strict();

const staffUpdateSchema = z
  .object({
    outletId: z.uuid().optional(),
    roleId: z.uuid().optional(),
    phone: z.string().trim().max(20).nullable().optional(),
    isActive: z.number().int().min(0).max(1).optional(),
  })
  .strict();

const activeQuery = z.enum(["0", "1"]).optional();
const scopeQuery = z.enum(["global", "outlet"]).optional();
const idParam = z.object({ id: z.uuid() });
const outletsQuery = z.object({ active: activeQuery });
const rolesQuery = z.object({ scope: scopeQuery });
const staffQuery = z.object({ outletId: z.uuid().optional(), roleId: z.uuid().optional(), active: activeQuery });

orgRoutes.get("/settings", async (c) => {
  await requireStaff(c.req.raw.headers);
  const row = getSettings();
  if (!row) throw new HTTPException(404, { message: "not_found" });
  return c.json(row);
});

orgRoutes.put("/settings", jsonValidator(settingsSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageStaff");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => updateSettings(tx, actor, body),
  });
  return respondIdempotent(c, result);
});

orgRoutes.get("/outlets", queryValidator(outletsQuery), async (c) => {
  await requireStaff(c.req.raw.headers);
  const q = c.req.valid("query");
  return c.json({ data: listOutlets({ active: q.active !== undefined ? q.active === "1" : undefined }) });
});

orgRoutes.post("/outlets", jsonValidator(outletCreateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageStaff");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => createOutlet(tx, actor, body),
  });
  return respondIdempotent(c, result);
});

orgRoutes.put("/outlets/:id", paramValidator(idParam), jsonValidator(outletUpdateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageStaff");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => updateOutlet(tx, actor, id, body),
  });
  return respondIdempotent(c, result);
});

orgRoutes.get("/roles", queryValidator(rolesQuery), async (c) => {
  await requireStaff(c.req.raw.headers);
  const q = c.req.valid("query");
  return c.json({ data: listRoles({ scope: q.scope }) });
});

orgRoutes.post("/roles", jsonValidator(roleCreateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageStaff");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => createRole(tx, actor, body),
  });
  return respondIdempotent(c, result);
});

orgRoutes.put("/roles/:id", paramValidator(idParam), jsonValidator(roleUpdateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageStaff");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => updateRole(tx, actor, id, body),
  });
  return respondIdempotent(c, result);
});

orgRoutes.get("/staff", queryValidator(staffQuery), async (c) => {
  await requireStaff(c.req.raw.headers);
  const q = c.req.valid("query");
  return c.json({
    data: listStaff({
      outletId: q.outletId,
      roleId: q.roleId,
      active: q.active !== undefined ? q.active === "1" : undefined,
    }),
  });
});

orgRoutes.post("/staff", jsonValidator(staffCreateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageStaff");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const operation = `${c.req.method} ${c.req.routePath}`;
  // T1: the auth user is created outside the idempotency transaction — better-auth
  // owns the user row and its own transaction (`architecture.md` §4.1). On a replay
  // the key already exists, so the user must not be created again: peek before the
  // external call, and let withIdempotency stay the single authoritative gate. A
  // duplicate-email race surfaces as 409 duplicate_email; the client retries with
  // the same key and gets the replay.
  const alreadyDone = key
    ? db
        .select({ id: idempotencyKeys.id })
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.operation, operation), eq(idempotencyKeys.key, key)))
        .get()
    : undefined;
  let userId: string | undefined;
  if (!alreadyDone) {
    const dup = db.select({ id: user.id }).from(user).where(eq(user.email, body.email.toLowerCase())).get();
    if (dup) throw new HTTPException(409, { message: "duplicate_email" });
    try {
      const signup = await auth.api.signUpEmail({ body: { name: body.name, email: body.email, password: body.password } });
      userId = signup.user.id;
    } catch (err) {
      if (String(err).includes("USER_ALREADY_EXISTS")) {
        throw new HTTPException(409, { message: "duplicate_email" });
      }
      throw err;
    }
  }
  const result = await withIdempotency({
    operation,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => createStaff(tx, actor, { userId: userId!, outletId: body.outletId, roleId: body.roleId, phone: body.phone ?? null }),
  });
  return respondIdempotent(c, result);
});

orgRoutes.put("/staff/:id", paramValidator(idParam), jsonValidator(staffUpdateSchema), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageStaff");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => updateStaff(tx, actor, id, body),
  });
  return respondIdempotent(c, result);
});

orgRoutes.post("/staff/:id/deactivate", paramValidator(idParam), jsonValidator(z.object({})), async (c) => {
  const actor = await requireStaff(c.req.raw.headers);
  requireCapability(actor, "canManageStaff");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = c.req.header("Idempotency-Key");
  const result = await withIdempotency({
    operation: `${c.req.method} ${c.req.routePath}`,
    key,
    actorId: actor.userId,
    body,
    run: (tx) => {
      deactivateStaffProfile(tx, actor, id);
      return {};
    },
  });
  return respondIdempotent(c, result);
});