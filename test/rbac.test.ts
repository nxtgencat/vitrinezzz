import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { user } from "../db/schema/auth";
import { customers } from "../db/schema/catalog";
import { auditEvents } from "../db/schema/facts";
import { outlets, roles, staffProfiles } from "../db/schema/org";

const tmpPath = join("data", `rbac-test-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.AUTH_SECRET = "rbac-test-secret";
process.env.SUPERUSER_EMAIL = "admin@rbac.test";
process.env.SUPERUSER_PASSWORD = "admin-pass-123";
process.env.NODE_ENV = "test";

const { db, withTx } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");
const { auth, ALL_CAPABILITIES, bootstrapAdmin } = await import("../lib/auth");
const { requireCapability, requireCustomer, requireStaff } = await import("../services/rbac");
const { deactivateStaffProfile } = await import("../services/staff");

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
  expect(res.status).toBe(200);
  return cookiesOf(res);
}

async function signIn(email: string, password: string): Promise<Headers> {
  const res = await authFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return cookiesOf(res);
}

function userIdByEmail(email: string): string {
  const row = db.select({ id: user.id }).from(user).where(eq(user.email, email)).get();
  expect(row).toBeDefined();
  return row!.id;
}

async function createProfile(userId: string, roleId: string, outletId: string, isProtected = 0): Promise<string> {
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
        isProtected,
        createdAt: t,
        updatedAt: t,
      })
      .run();
  });
  return profileId;
}

beforeAll(async () => {
  mkdirSync("data", { recursive: true });
  applyMigrations(db);
  await bootstrapAdmin();
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
});

describe("bootstrap admin", () => {
  test("second boot is idempotent — exactly one protected profile", async () => {
    await bootstrapAdmin();
    await bootstrapAdmin();
    const protectedProfiles = db.select().from(staffProfiles).where(eq(staffProfiles.isProtected, 1)).all();
    expect(protectedProfiles.length).toBe(1);
    const adminRole = db.select().from(roles).where(eq(roles.name, "Admin")).get();
    expect(adminRole).toBeDefined();
    expect(adminRole!.scope).toBe("global");
    expect([...adminRole!.capabilities].sort()).toEqual([...ALL_CAPABILITIES].sort());
    const outletsAll = db.select().from(outlets).all();
    expect(outletsAll.length).toBe(1);
    expect(outletsAll[0]!.name).toBe("Main Outlet");
  });

  test("bootstrap writes system audit rows", () => {
    const rows = db.select().from(auditEvents).where(eq(auditEvents.actorType, "system")).all();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.actorId === "system")).toBe(true);
  });
});

describe("sign-up auto-provisions customer profile", () => {
  test("user.create.after inserts the customers row in the same flow", async () => {
    const cookies = await signUp("prov@rbac.test", "prov-pass-123", "Provisioned");
    const row = db.select().from(customers).where(eq(customers.userId, userIdByEmail("prov@rbac.test"))).get();
    expect(row).toBeDefined();
    expect(row!.name).toBe("Provisioned");
    expect(row!.isActive).toBe(1);

    const actor = await requireCustomer(cookies);
    expect(actor.customerId).toBe(row!.id);
  });
});

describe("guards", () => {
  let customerCookies: Headers;

  beforeAll(async () => {
    customerCookies = await signUp("guard-cust@rbac.test", "guard-pass-123", "Guard Customer");
  });

  test("no session -> 401", async () => {
    await expect(requireStaff(new Headers())).rejects.toMatchObject({ status: 401 });
    await expect(requireCustomer(new Headers())).rejects.toMatchObject({ status: 401 });
  });

  test("customer session on requireStaff -> 403, never 500", async () => {
    try {
      await requireStaff(customerCookies);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(HTTPException);
      expect((err as HTTPException).status).toBe(403);
    }
  });

  test("bootstrap admin session on requireStaff -> full actor", async () => {
    const cookies = await signIn("admin@rbac.test", "admin-pass-123");
    const actor = await requireStaff(cookies);
    expect(actor.capabilities.length).toBe(ALL_CAPABILITIES.length);
    expect(actor.roleScope).toBe("global");
  });
});

describe("deactivateStaffProfile service", () => {
  let adminActor: Awaited<ReturnType<typeof requireStaff>>;
  let limitedActor: Awaited<ReturnType<typeof requireStaff>>;
  let outletActor: Awaited<ReturnType<typeof requireStaff>>;
  let victimProfileId: string;
  let otherOutletProfileId: string;

  beforeAll(async () => {
    const adminCookies = await signIn("admin@rbac.test", "admin-pass-123");
    adminActor = await requireStaff(adminCookies);

    const mainOutlet = db.select().from(outlets).limit(1).get()!;

    const clerkRoleId = randomUUIDv7();
    const smRoleId = randomUUIDv7();
    const now = Date.now();
    await withTx((tx) => {
      tx.insert(roles)
        .values([
          {
            id: clerkRoleId,
            name: "TestClerk",
            capabilities: ["canManageSales"],
            scope: "global",
            outletId: null,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: smRoleId,
            name: "TestSM",
            capabilities: ["canManageStaff"],
            scope: "outlet",
            outletId: mainOutlet.id,
            createdAt: now,
            updatedAt: now,
          },
        ])
        .run();
    });

    const limitedCookies = await signUp("limited@rbac.test", "limited-pass-123", "Limited");
    const outletCookies = await signUp("outlet-mgr@rbac.test", "outlet-pass-123", "Outlet Mgr");
    await signUp("victim@rbac.test", "victim-pass-123", "Victim");
    await signUp("other@rbac.test", "other-pass-123", "Other");

    const otherOutletId = randomUUIDv7();
    await withTx((tx) => {
      tx.insert(outlets)
        .values({ id: otherOutletId, name: "Other Outlet", isActive: 1, createdAt: now, updatedAt: now })
        .run();
    });
    victimProfileId = await createProfile(userIdByEmail("victim@rbac.test"), clerkRoleId, mainOutlet.id);
    otherOutletProfileId = await createProfile(userIdByEmail("other@rbac.test"), clerkRoleId, otherOutletId);
    await createProfile(userIdByEmail("limited@rbac.test"), clerkRoleId, mainOutlet.id);
    await createProfile(userIdByEmail("outlet-mgr@rbac.test"), smRoleId, mainOutlet.id);

    limitedActor = await requireStaff(limitedCookies);
    outletActor = await requireStaff(outletCookies);
  });

  test("without the capability -> 403 from a direct service call", async () => {
    await expect(
      withTx((tx) => deactivateStaffProfile(tx, limitedActor, victimProfileId)),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("outlet-scoped role cannot reach another outlet -> 403", async () => {
    await expect(
      withTx((tx) => deactivateStaffProfile(tx, outletActor, otherOutletProfileId)),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("outlet-scoped actor with no declared scope -> 403", async () => {
    expect(() => requireCapability(outletActor, "canManageStaff")).toThrow(HTTPException);
    try {
      requireCapability(outletActor, "canManageStaff");
      throw new Error("expected rejection");
    } catch (err) {
      expect((err as HTTPException).status).toBe(403);
    }
  });

  test("deactivating the protected bootstrap admin -> 409 protected_resource from every angle", async () => {
    const protectedProfile = db.select().from(staffProfiles).where(eq(staffProfiles.isProtected, 1)).get()!;
    await expect(
      withTx((tx) => deactivateStaffProfile(tx, adminActor, protectedProfile.id)),
    ).rejects.toMatchObject({ status: 409, message: "protected_resource" });
  });

  test("unknown target -> 404", async () => {
    await expect(
      withTx((tx) => deactivateStaffProfile(tx, adminActor, randomUUIDv7())),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("allowed deactivation writes the audit row", async () => {
    await withTx((tx) => deactivateStaffProfile(tx, adminActor, victimProfileId));
    const row = db.select().from(staffProfiles).where(eq(staffProfiles.id, victimProfileId)).get();
    expect(row!.isActive).toBe(0);
    const audit = db.select().from(auditEvents).where(eq(auditEvents.entityId, victimProfileId)).all();
    expect(audit.some((r) => r.action === "deactivated" && r.actorType === "staff")).toBe(true);
  });
});
