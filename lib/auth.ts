import { randomUUIDv7 } from "bun";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db, withTx } from "./db";
import { logger } from "./logger";
import { account, session, user, verification } from "../db/schema/auth";
import { customers } from "../db/schema/catalog";
import { outlets, roles, staffProfiles } from "../db/schema/org";
import { writeAuditEvent } from "../services/audit";

export const ALL_CAPABILITIES = [
  "canManageCatalog",
  "canManageInventory",
  "canManagePurchases",
  "canManageSales",
  "canManagePayments",
  "canManageReturns",
  "canManageFulfillment",
  "canManageStaff",
  "canManageStorefront",
] as const;

export type Capability = (typeof ALL_CAPABILITIES)[number];

export function isCapability(value: string): value is Capability {
  return (ALL_CAPABILITIES as readonly string[]).includes(value);
}

const DEFAULT_OUTLET_NAME = "Main Outlet";

const trustedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    transaction: true,
    schema: { user, session, account, verification },
  }),
  secret: process.env.AUTH_SECRET,
  ...(trustedOrigins.length > 0 ? { trustedOrigins } : {}),
  emailAndPassword: { enabled: true },
  ...(process.env.NODE_ENV === "test" || process.env.TEST === "true"
    ? { rateLimit: { customRules: { "*": false } } }
    : {}),
  databaseHooks: {
    user: {
      create: {
        after: async (createdUser) => {
          const now = Date.now();
          await withTx((tx) => {
            tx.insert(customers)
              .values({
                id: randomUUIDv7(),
                userId: createdUser.id,
                name: createdUser.name,
                isActive: 1,
                createdAt: now,
                updatedAt: now,
              })
              .run();
          });
          logger.info({ userId: createdUser.id }, "customer profile auto-provisioned");
        },
      },
    },
  },
});

/**
 * Idempotent boot step: seeds the global Admin role (all nine capabilities), a
 * default outlet when none exists, and the protected bootstrap admin profile from
 * `SUPERUSER_EMAIL`/`SUPERUSER_PASSWORD`. Runs every boot, acts once.
 */
export async function bootstrapAdmin(): Promise<void> {
  let adminRoleId: string;
  const existingRole = db.select({ id: roles.id }).from(roles).where(eq(roles.name, "Admin")).get();
  if (existingRole) {
    adminRoleId = existingRole.id;
  } else {
    const roleId = randomUUIDv7();
    const now = Date.now();
    await withTx((tx) => {
      tx.insert(roles)
        .values({
          id: roleId,
          name: "Admin",
          capabilities: [...ALL_CAPABILITIES],
          scope: "global",
          outletId: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      writeAuditEvent(tx, {
        entityType: "role",
        entityId: roleId,
        action: "created",
        actorId: "system",
        actorType: "system",
        before: null,
        after: { id: roleId, name: "Admin", scope: "global", capabilities: [...ALL_CAPABILITIES] },
      });
    });
    logger.info({ roleId }, "seeded Admin role");
    adminRoleId = roleId;
  }

  const existingOutlet = db.select({ id: outlets.id }).from(outlets).limit(1).get();
  if (!existingOutlet) {
    const outletId = randomUUIDv7();
    const now = Date.now();
    await withTx((tx) => {
      tx.insert(outlets)
        .values({ id: outletId, name: DEFAULT_OUTLET_NAME, isActive: 1, createdAt: now, updatedAt: now })
        .run();
      writeAuditEvent(tx, {
        entityType: "outlet",
        entityId: outletId,
        action: "created",
        actorId: "system",
        actorType: "system",
        before: null,
        after: { id: outletId, name: DEFAULT_OUTLET_NAME, isActive: 1 },
      });
    });
    logger.info({ outletId }, `seeded default outlet "${DEFAULT_OUTLET_NAME}"`);
  }

  const superuserEmail = process.env.SUPERUSER_EMAIL;
  const superuserPassword = process.env.SUPERUSER_PASSWORD;
  if (!superuserEmail || !superuserPassword) {
    logger.warn("SUPERUSER_EMAIL/SUPERUSER_PASSWORD not set — bootstrap admin skipped");
    return;
  }
  if (!process.env.AUTH_SECRET) {
    throw new Error("AUTH_SECRET is required when SUPERUSER_EMAIL/SUPERUSER_PASSWORD are set");
  }

  const email = superuserEmail.toLowerCase();
  let adminUser = db.select().from(user).where(eq(user.email, email)).get();
  if (!adminUser) {
    const signup = await auth.api.signUpEmail({
      body: { name: "Administrator", email, password: superuserPassword },
    });
    adminUser = db.select().from(user).where(eq(user.email, email)).get();
    if (!adminUser) {
      throw new Error(`bootstrap admin user creation failed for ${email}`);
    }
    logger.info({ userId: adminUser.id, email: signup.user.email }, "bootstrap admin user created");
  }

  const existingProfile = db
    .select()
    .from(staffProfiles)
    .where(eq(staffProfiles.userId, adminUser.id))
    .get();
  if (!existingProfile) {
    const outlet = db.select({ id: outlets.id }).from(outlets).limit(1).get();
    if (!outlet) throw new Error("bootstrap admin needs an outlet but none exists");
    const profileId = randomUUIDv7();
    const now = Date.now();
    await withTx((tx) => {
      tx.insert(staffProfiles)
        .values({
          id: profileId,
          userId: adminUser.id,
          outletId: outlet.id,
          roleId: adminRoleId,
          phone: null,
          isActive: 1,
          isProtected: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      writeAuditEvent(tx, {
        entityType: "staff",
        entityId: profileId,
        action: "created",
        actorId: "system",
        actorType: "system",
        before: null,
        after: { id: profileId, userId: adminUser.id, outletId: outlet.id, roleId: adminRoleId, isProtected: 1 },
      });
    });
    logger.info({ userId: adminUser.id }, "bootstrap admin profile created");
  }
}
