import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { user } from "../db/schema/auth";
import { customers } from "../db/schema/catalog";
import { auditEvents } from "../db/schema/facts";
import { outlets, roles, staffProfiles } from "../db/schema/org";

process.env.NODE_ENV = "test";
const tmpPath = join("data", `verify-rbac-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.AUTH_SECRET = "verify-rbac-secret";
process.env.SUPERUSER_EMAIL = "admin@vitrine.test";
process.env.SUPERUSER_PASSWORD = "admin-pass-123";

const { db, withTx } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");
const { auth, ALL_CAPABILITIES, bootstrapAdmin } = await import("../lib/auth");
const { requireCapability, requireCustomer, requireStaff } = await import("../services/rbac");
const { deactivateStaffProfile } = await import("../services/staff");
const { writeAuditEvent } = await import("../services/audit");
const { logger } = await import("../lib/logger");

const log = logger.child({ module: "verify-rbac" });
const failures: string[] = [];

mkdirSync("data", { recursive: true });

function assert(cond: boolean, msg: string): void {
  if (!cond) failures.push(msg);
}

async function expectHttpError(fn: () => unknown, status: number, label: string): Promise<void> {
  try {
    await fn();
    failures.push(`${label}: expected HTTPException ${status}, nothing was thrown`);
  } catch (err) {
    if (!(err instanceof HTTPException) || err.status !== status) {
      failures.push(`${label}: expected HTTPException ${status}, got ${String(err)}`);
    }
  }
}

function cookiesOf(res: Response): Headers {
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => c.length > 0)
    .join("; ");
  return new Headers({ cookie });
}

function authFetch(path: string, init: RequestInit): Promise<Response> {
  return auth.handler(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    }),
  );
}

async function signUp(email: string, password: string, name: string): Promise<Headers> {
  const res = await authFetch("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password, name }),
  });
  assert(res.status === 200, `sign-up ${email} returned ${res.status}, expected 200`);
  return cookiesOf(res);
}

async function signIn(email: string, password: string): Promise<Headers> {
  const res = await authFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  assert(res.status === 200, `sign-in ${email} returned ${res.status}, expected 200`);
  return cookiesOf(res);
}

function userIdByEmail(email: string): string {
  const row = db.select({ id: user.id }).from(user).where(eq(user.email, email)).get();
  assert(Boolean(row), `user ${email} must exist`);
  return row!.id;
}

async function createProfile(userId: string, roleId: string, outletId: string): Promise<string> {
  const profileId = randomUUIDv7();
  const t = Date.now();
  await withTx((tx) => {
    tx.insert(staffProfiles)
      .values({
        id: profileId,
        userId,
        outletId,
        roleId,
        phone: null,
        isActive: 1,
        isProtected: 0,
        createdAt: t,
        updatedAt: t,
      })
      .run();
    writeAuditEvent(tx, {
      entityType: "staff",
      entityId: profileId,
      action: "created",
      actorId: "system",
      actorType: "system",
      before: null,
      after: { id: profileId, userId, outletId, roleId, isProtected: 0 },
    });
  });
  return profileId;
}

const now = Date.now();

applyMigrations(db);
await bootstrapAdmin();
await bootstrapAdmin();

const protectedProfiles = db.select().from(staffProfiles).where(eq(staffProfiles.isProtected, 1)).all();
assert(protectedProfiles.length === 1, `expected exactly one protected profile, got ${protectedProfiles.length}`);
assert(protectedProfiles[0]!.isActive === 1, "protected profile must be active");

const adminRole = db.select().from(roles).where(eq(roles.name, "Admin")).get();
assert(Boolean(adminRole), "Admin role must exist");
assert(adminRole!.scope === "global", "Admin role must be global");
assert(
  JSON.stringify([...adminRole!.capabilities].sort()) === JSON.stringify([...ALL_CAPABILITIES].sort()),
  "Admin role must carry all nine capabilities",
);

const outletsAll = db.select().from(outlets).all();
assert(outletsAll.length === 1, `expected exactly one outlet after bootstrap, got ${outletsAll.length}`);
assert(outletsAll[0]!.name === "Main Outlet", "default outlet must be named Main Outlet");

const bootstrapAudit = db.select().from(auditEvents).where(eq(auditEvents.actorType, "system")).all();
assert(bootstrapAudit.length >= 3, `expected system audit rows for role/outlet/staff seeds, got ${bootstrapAudit.length}`);
assert(
  bootstrapAudit.every((row) => row.actorId === "system"),
  "all bootstrap audit rows must carry actorId 'system'",
);

const customerCookies = await signUp("cust1@test.in", "customer-pass-123", "Cust One");
const customerRow = db.select().from(customers).where(eq(customers.userId, userIdByEmail("cust1@test.in"))).get();
assert(Boolean(customerRow), "sign-up must auto-provision a customers row");
assert(customerRow!.name === "Cust One", "customer row must copy the user's name");
assert(customerRow!.isActive === 1, "customer row must be active");

await expectHttpError(() => requireStaff(new Headers()), 401, "requireStaff without session");
await expectHttpError(() => requireCustomer(new Headers()), 401, "requireCustomer without session");
await expectHttpError(() => requireStaff(customerCookies), 403, "requireStaff as customer");
const customerActor = await requireCustomer(customerCookies);
assert(customerActor.customerId === customerRow!.id, "requireCustomer must return the provisioned profile");

const adminCookies = await signIn("admin@vitrine.test", "admin-pass-123");
const adminActor = await requireStaff(adminCookies);
assert(adminActor.capabilities.length === ALL_CAPABILITIES.length, "admin must carry all nine capabilities");
assert(adminActor.roleScope === "global", "admin role must be global");

const mainOutlet = outletsAll[0]!;
const outlet2Id = randomUUIDv7();
await withTx((tx) => {
  tx.insert(outlets)
    .values({ id: outlet2Id, name: "Outlet Two", isActive: 1, createdAt: now, updatedAt: now })
    .run();
  writeAuditEvent(tx, {
    entityType: "outlet",
    entityId: outlet2Id,
    action: "created",
    actorId: "system",
    actorType: "system",
    before: null,
    after: { id: outlet2Id, name: "Outlet Two", isActive: 1 },
  });
});

const clerkRoleId = randomUUIDv7();
const smRoleId = randomUUIDv7();
await withTx((tx) => {
  tx.insert(roles)
    .values([
      {
        id: clerkRoleId,
        name: "Clerk",
        capabilities: ["canManageSales"],
        scope: "global",
        outletId: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: smRoleId,
        name: "SM-Main",
        capabilities: ["canManageStaff"],
        scope: "outlet",
        outletId: mainOutlet.id,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();
});

const clerkCookies = await signUp("clerk@test.in", "clerk-pass-123", "Clerk One");
const smCookies = await signUp("sm@test.in", "sm-pass-123", "Store Mgr");
const victim1Cookies = await signUp("victim1@test.in", "victim-pass-123", "Victim One");
await signUp("victim2@test.in", "victim-pass-123", "Victim Two");

const clerkProfileId = await createProfile(userIdByEmail("clerk@test.in"), clerkRoleId, mainOutlet.id);
await createProfile(userIdByEmail("sm@test.in"), smRoleId, mainOutlet.id);
const victim1ProfileId = await createProfile(userIdByEmail("victim1@test.in"), clerkRoleId, mainOutlet.id);
const victim2ProfileId = await createProfile(userIdByEmail("victim2@test.in"), clerkRoleId, outlet2Id);

const clerkActor = await requireStaff(clerkCookies);
const smActor = await requireStaff(smCookies);
assert(
  JSON.stringify(clerkActor.capabilities) === JSON.stringify(["canManageSales"]),
  "clerk capabilities must be exactly [canManageSales]",
);
assert(smActor.roleScope === "outlet" && smActor.outletId === mainOutlet.id, "SM must be outlet-scoped to Main Outlet");

await expectHttpError(
  () => withTx((tx) => deactivateStaffProfile(tx, clerkActor, victim1ProfileId)),
  403,
  "clerk deactivating a profile without canManageStaff",
);

await expectHttpError(
  () => withTx((tx) => deactivateStaffProfile(tx, smActor, victim2ProfileId)),
  403,
  "outlet-scoped SM deactivating a profile in another outlet",
);

await expectHttpError(
  () => requireCapability(smActor, "canManageStaff"),
  403,
  "outlet-scoped actor with an unscoped operation",
);

await withTx((tx) => deactivateStaffProfile(tx, smActor, victim1ProfileId));
const victim1After = db.select().from(staffProfiles).where(eq(staffProfiles.id, victim1ProfileId)).get();
assert(victim1After!.isActive === 0, "victim1 profile must be deactivated");
const deactivateAudit = db.select().from(auditEvents).where(eq(auditEvents.entityId, victim1ProfileId)).all();
assert(
  deactivateAudit.some(
    (row) =>
      row.action === "deactivated" && row.actorType === "staff" && row.actorId === userIdByEmail("sm@test.in"),
  ),
  "deactivation must write a staff-actor audit row",
);

await expectHttpError(
  () => withTx((tx) => deactivateStaffProfile(tx, adminActor, protectedProfiles[0]!.id)),
  409,
  "deactivating the protected bootstrap admin",
);

await expectHttpError(
  () => withTx((tx) => deactivateStaffProfile(tx, adminActor, randomUUIDv7())),
  404,
  "deactivating an unknown profile",
);

await withTx((tx) => deactivateStaffProfile(tx, adminActor, clerkProfileId));
await expectHttpError(() => requireStaff(clerkCookies), 403, "requireStaff on a deactivated profile");
await expectHttpError(() => requireStaff(victim1Cookies), 403, "requireStaff on a deactivated victim");

const protectedAgain = db.select().from(staffProfiles).where(eq(staffProfiles.isProtected, 1)).all();
assert(protectedAgain.length === 1, `exactly one protected profile must survive, got ${protectedAgain.length}`);

const adminStillValid = await requireStaff(adminCookies);
assert(adminStillValid.userId === userIdByEmail("admin@vitrine.test"), "admin session must still resolve");

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0], all: failures }, "verify-rbac FAILED");
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
  process.exit(1);
}

log.info("verify-rbac PASS");
db.$client.close();
rmSync(tmpPath, { force: true });
rmSync(`${tmpPath}-wal`, { force: true });
rmSync(`${tmpPath}-shm`, { force: true });