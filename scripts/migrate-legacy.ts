/**
 * One-shot migration from the legacy PocketBase schema (`legacy/schema.js`)
 * into the Vitrine SQLite schema (`schema.md`).
 *
 * Source: the PocketBase instance in `legacy/.env` (`PB_PUBLIC_URL`,
 * `PB_ADMIN_EMAIL`, `PB_ADMIN_PASSWORD`). Target: `DATABASE_PATH`
 * (default `./data/vitrine.sqlite`) — must be a fresh file; the script aborts
 * if the target already holds data.
 *
 * Mapping (`legacy/schema.js` → `schema.md`):
 *
 *   organisations            → settings (singleton) + one outlet
 *   currencies               → settings.currency (code only)
 *   users                    → user + account (credential, password null —
 *                              PB bcrypt is not portable; password reset required)
 *   tax_rates                → products.gstRatePct (via items.tax_rate)
 *   item_groups              → categories
 *   items                    → products + variants (parent_item → extra variant)
 *   items.image              → NOT migrated (image downloads deliberately
 *                              skipped — no media rows or files are created)
 *   customers                → customers (phone-deduped)
 *   storefront_customers     → customers (merged; userId linked where mapped)
 *   customer_addresses       → cust_addresses
 *   vendors                  → vendors
 *   invoices                 → orders + invoices + invoice_items + invoice_charges
 *                              (charges from discount / round_off / extra_charges;
 *                              totals recomputed from line snapshots)
 *   bills                    → purchase_bills + purchase_bill_items + bill_charges
 *   payments_received        → payments (direction=in, partyType=customer)
 *   payments_made            → payments (direction=out, partyType=vendor)
 *   sales_returns            → returns + return_items (originalItemId matched to
 *                              the invoice line of the same item)
 *   storefront_orders        → orders (storefront) + draft/issued invoices +
 *                              pending/confirmed gateway payments
 *   order_tracking           → order_events
 *
 * Deliberately not migrated (no target table; new schema has no such domain —
 * `architecture.md` §5): partners, partner_investments, partner_commitments,
 * item_conversions (their stock effect is already netted into current_stock,
 * which is zero everywhere — replaying them would fabricate stock),
 * credit_notes, vendor_credits, purchase_returns, inventory_adjustments (all
 * empty in the source).
 *
 * Legacy stock: every item has current_stock 0, so no batches, no
 * `stock_movements`, no `stock_levels` rows are seeded — the migrated DB starts
 * stock-clean. Legacy invoice_items.allocations are `[]` for the same reason.
 *
 * Conventions: all money ×100 → paise (round); PB RFC3339 timestamps
 * (space-separated) → INTEGER unix-ms; all legacy document numbers kept
 * verbatim (unique in the source); new OR-/INV-/PY- numbers drawn fresh.
 *
 * Re-runs are safe by construction: the target-data guard aborts before any
 * write if the DB already contains data, and the server-activity guard aborts
 * if any source record was created/updated within the activity window
 * (`MIGRATION_ACTIVITY_WINDOW_MINUTES`, default 15) — migrating from a
 * live-changing server is unsafe.
 */
import { randomUUIDv7 } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { account, user } from "../db/schema/auth";
import { categories, customers, custAddresses, products, variants, vendors } from "../db/schema/catalog";
import { orderEvents } from "../db/schema/facts";
import { invoiceCharges, invoiceItems, invoices, orders, returnItems, returns } from "../db/schema/orders";
import { outlets, roles, settings, staffProfiles } from "../db/schema/org";
import { payments } from "../db/schema/payments";
import { billCharges, purchaseBillItems, purchaseBills } from "../db/schema/purchasing";
import { ALL_CAPABILITIES } from "../lib/auth";
import { db, withTx } from "../lib/db";
import { freshDocNumber } from "../lib/doc-number";
import { logger } from "../lib/logger";
import { applyMigrations } from "../lib/migrate";
import { slugifyName } from "../services/catalog";

const log = logger.child({ module: "migrate-legacy" });

// ---------------------------------------------------------------------------
// Environment: PB credentials come from legacy/.env (loaded only if not
// already set); target DB comes from DATABASE_PATH (defaults to
// ./data/vitrine.sqlite, set at import time by lib/db.ts).
// ---------------------------------------------------------------------------

const legacyEnvPath = join(import.meta.dir, "..", "legacy", ".env");
for (const line of readFileSync(legacyEnvPath, "utf8").split("\n")) {
  const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
  if (!match) continue;
  const key = match[1]!;
  const value = match[2]!.replace(/^["']|["']$/g, "");
  if (process.env[key] === undefined) process.env[key] = value;
}

const pbUrl = process.env.PB_PUBLIC_URL;
const pbAdminEmail = process.env.PB_ADMIN_EMAIL;
const pbAdminPassword = process.env.PB_ADMIN_PASSWORD;
if (!pbUrl || !pbAdminEmail || !pbAdminPassword) {
  log.error("PB_PUBLIC_URL / PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD must be set (legacy/.env)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Legacy record shapes (only the fields read are typed). `deleted_at` is
// present on every collection except the marked `noSoftDelete` ones
// (`legacy/schema.js`) — soft-deleted rows are skipped and counted.
// ---------------------------------------------------------------------------

type LRow = { id: string; created: string; updated: string };
type LOrg = LRow & { name: string; gstin: string; base_currency: string; fiscal_year_start_month: number; timezone: string };
type LCurrency = LRow & { code: string };
type LTaxRate = LRow & { rate: number };
type LItemGroup = LRow & { name: string };
type LUser = LRow & { name: string; email: string; phone: string; verified: boolean };
type LItem = LRow & {
  name: string;
  sku: string;
  hsn_code: string;
  tax_rate: string;
  selling_price: number;
  purchase_price: number;
  mrp: number;
  current_stock: number;
  item_group: string;
  parent_item: string;
  is_purchasable: boolean;
  is_sellable: boolean;
  image: string;
  deleted_at: string;
};
type LCustomer = LRow & { name: string; display_name: string; phone: string; gstin: string; deleted_at: string };
type LStorefrontCustomer = LRow & { phone: string; name: string; user: string; deleted_at: string };
type LAddress = LRow & {
  customer: string;
  label: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  is_default: boolean;
  deleted_at: string;
};
type LVendor = LRow & { name: string; phone: string; gstin: string; deleted_at: string };
type LInvoice = LRow & {
  customer: string;
  invoice_number: string;
  invoice_date: string;
  subtotal: number;
  tax_amount: number;
  discount: number;
  round_off: number;
  extra_charges: unknown;
  total: number;
  status: string;
  deleted_at: string;
};
type LInvoiceItem = LRow & { invoice: string; item: string; quantity: number; rate: number; tax_amount: number; tax_rate: string; amount: number };
type LBill = LRow & {
  vendor: string;
  bill_number: string;
  discount: number;
  round_off: number;
  extra_charges: unknown;
  total: number;
  status: string;
  deleted_at: string;
};
type LBillItem = LRow & { bill: string; item: string; quantity: number; rate: number; tax_amount: number; tax_rate: string; amount: number };
type LPaymentReceived = LRow & {
  payment_number: string;
  customer: string;
  invoice: string;
  amount: number;
  payment_date: string;
  payment_mode: string;
  deleted_at: string;
};
type LPaymentMade = LRow & {
  payment_number: string;
  vendor: string;
  bill: string;
  amount: number;
  payment_date: string;
  payment_mode: string;
  deleted_at: string;
};
type LReturn = LRow & {
  return_number: string;
  invoice: string;
  status: string;
  deleted_at: string;
};
type LReturnItem = LRow & { sales_return: string; item: string; quantity: number; rate: number; tax_amount: number; amount: number };
type LStorefrontOrder = LRow & {
  order_number: string;
  customer: string;
  status: string;
  payment_status: string;
  payment_order_id: string;
  shipping_charge: number;
  discount: number;
  total: number;
  amount_paid: number;
  deleted_at: string;
};
type LOrderItem = LRow & { order: string; item: string; item_name: string; quantity: number; selling_price: number; total: number };
type LTracking = LRow & { order: string; status: string; note: string; is_admin_note: boolean; deleted_at: string };

function isSoftDeleted(row: Record<string, unknown>): boolean {
  return typeof row["deleted_at"] === "string" && row["deleted_at"] !== "";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rupees (decimal, as stored in legacy) → integer paise. */
function paise(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** PB RFC3339 ("2026-08-14 13:51:31.961Z", space-separated) or unix-ms → unix-ms. */
function ts(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value.replace(" ", "T"));
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function numberOrZero(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

type ExtraCharge = { name: string; amount: number };

/** `extra_charges` json → {name, amount} pairs (defensive: arbitrary item shape). */
function parseExtraCharges(value: unknown): ExtraCharge[] {
  if (!Array.isArray(value)) return [];
  const out: ExtraCharge[] = [];
  for (const entry of value) {
    if (typeof entry === "number") {
      if (entry !== 0) out.push({ name: "Charge", amount: entry });
      continue;
    }
    if (entry && typeof entry === "object") {
      const o = entry as Record<string, unknown>;
      const amount = numberOrZero(o["amount"] ?? o["value"]);
      if (amount === 0) continue;
      const rawName = typeof o["name"] === "string" ? o["name"] : typeof o["label"] === "string" ? o["label"] : "";
      out.push({ name: rawName.trim() !== "" ? rawName.trim() : "Charge", amount });
    }
  }
  return out;
}

/** Invoice/bill header charges from discount, round_off and extra_charges. */
function buildCharges(discount: unknown, roundOff: unknown, extra: unknown): { name: string; amountPaise: number }[] {
  const out: { name: string; amountPaise: number }[] = [];
  const discountValue = numberOrZero(discount);
  if (discountValue !== 0) out.push({ name: "Discount", amountPaise: -paise(discountValue) });
  const roundOffValue = numberOrZero(roundOff);
  if (roundOffValue !== 0) out.push({ name: "Round off", amountPaise: paise(roundOffValue) });
  for (const c of parseExtraCharges(extra)) out.push({ name: c.name, amountPaise: paise(c.amount) });
  return out;
}

const PAYMENT_MODE_MAP: Record<string, string> = {
  cash: "cash",
  cheque: "bank",
  bank_transfer: "bank",
  upi: "upi",
  card: "card",
};

// ---------------------------------------------------------------------------
// Source fetch
// ---------------------------------------------------------------------------

type LList<T> = { items: T[]; totalPages: number };

async function fetchAll<T>(collection: string, filter?: string): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const qs = new URLSearchParams({ page: String(page), perPage: "200" });
    if (filter) qs.set("filter", filter);
    const res = await fetch(`${pbUrl}/api/collections/${collection}/records?${qs}`, { headers: authHeaders });
    if (!res.ok) throw new Error(`PB ${collection} page ${page}: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as LList<T>;
    out.push(...body.items);
    totalPages = body.totalPages;
    page += 1;
  } while (page <= totalPages);
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let authHeaders: Record<string, string>;

const report = {
  sourceCollections: 0,
  skippedSoftDeleted: 0,
  skippedOrphanPayments: 0,
  duplicateSlugs: 0,
  duplicateSkus: 0,
  duplicatePhones: 0,
  fractionalQuantities: 0,
  renamedDocumentNumbers: 0,
  invoiceTotalsDrift: 0,
  billTotalsDrift: 0,
  skippedImages: 0,
  skips: [] as string[],
};

type Counts = {
  outlets: number;
  settings: number;
  roles: number;
  users: number;
  accounts: number;
  staffProfiles: number;
  categories: number;
  products: number;
  variants: number;
  customers: number;
  custAddresses: number;
  vendors: number;
  ordersManual: number;
  invoicesManual: number;
  invoiceItems: number;
  invoiceCharges: number;
  purchaseBills: number;
  purchaseBillItems: number;
  billCharges: number;
  payments: number;
  returns: number;
  returnItems: number;
  ordersStorefront: number;
  invoicesStorefront: number;
  storefrontInvoiceItems: number;
  storefrontInvoiceCharges: number;
  storefrontPayments: number;
  orderEvents: number;
};

const counts: Counts = {
  outlets: 1,
  settings: 1,
  roles: 0,
  users: 0,
  accounts: 0,
  staffProfiles: 0,
  categories: 0,
  products: 0,
  variants: 0,
  customers: 0,
  custAddresses: 0,
  vendors: 0,
  ordersManual: 0,
  invoicesManual: 0,
  invoiceItems: 0,
  invoiceCharges: 0,
  purchaseBills: 0,
  purchaseBillItems: 0,
  billCharges: 0,
  payments: 0,
  returns: 0,
  returnItems: 0,
  ordersStorefront: 0,
  invoicesStorefront: 0,
  storefrontInvoiceItems: 0,
  storefrontInvoiceCharges: 0,
  storefrontPayments: 0,
  orderEvents: 0,
};

async function main(): Promise<void> {
  const login = await fetch(`${pbUrl}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: pbAdminEmail, password: pbAdminPassword }),
  });
  if (!login.ok) {
    log.error({ status: login.status }, "PB auth failed");
    process.exit(1);
  }
  const body = (await login.json()) as { token: string };
  authHeaders = { Authorization: body.token };

  const [orgRows, currencyRows, userRows, taxRows, groupRows, itemRows, customerRows, sfCustomerRows, addressRows, vendorRows, invoiceRows, invoiceItemRows, paymentReceivedRows, billRows, billItemRows, paymentMadeRows, returnRows, returnItemRows, sfOrderRows, orderItemRows, trackingRows] =
    await Promise.all([
      fetchAll<LOrg>("organisations"),
      fetchAll<LCurrency>("currencies"),
      fetchAll<LUser>("users"),
      fetchAll<LTaxRate>("tax_rates"),
      fetchAll<LItemGroup>("item_groups"),
      fetchAll<LItem>("items"),
      fetchAll<LCustomer>("customers"),
      fetchAll<LStorefrontCustomer>("storefront_customers"),
      fetchAll<LAddress>("customer_addresses"),
      fetchAll<LVendor>("vendors"),
      fetchAll<LInvoice>("invoices"),
      fetchAll<LInvoiceItem>("invoice_items"),
      fetchAll<LPaymentReceived>("payments_received"),
      fetchAll<LBill>("bills"),
      fetchAll<LBillItem>("bill_items"),
      fetchAll<LPaymentMade>("payments_made"),
      fetchAll<LReturn>("sales_returns"),
      fetchAll<LReturnItem>("sales_return_items"),
      fetchAll<LStorefrontOrder>("storefront_orders"),
      fetchAll<LOrderItem>("order_items"),
      fetchAll<LTracking>("order_tracking"),
    ]);

  // ── Server-use guard: abort if anything touched the source recently. ─────
  // A live server keeps mutating between the fetch and the commit; migrating
  // from it would silently drop whatever happened mid-run. Window is
  // `MIGRATION_ACTIVITY_WINDOW_MINUTES` (default 15).
  const activityWindowMinutes = Math.max(
    1,
    Number(process.env.MIGRATION_ACTIVITY_WINDOW_MINUTES ?? 15) || 15,
  );
  let latestActivity = 0;
  for (const rows of [
    orgRows, currencyRows, userRows, taxRows, groupRows, itemRows,
    customerRows, sfCustomerRows, addressRows, vendorRows, invoiceRows,
    invoiceItemRows, paymentReceivedRows, billRows, billItemRows,
    paymentMadeRows, returnRows, returnItemRows, sfOrderRows, orderItemRows,
    trackingRows,
  ]) {
    for (const row of rows) {
      for (const field of [row.created, row.updated]) {
        if (typeof field !== "string" || field === "") continue;
        const parsed = Date.parse(field.replace(" ", "T"));
        if (!Number.isNaN(parsed) && parsed > latestActivity) latestActivity = parsed;
      }
    }
  }
  if (Date.now() - latestActivity < activityWindowMinutes * 60_000) {
    log.error(
      { latestActivity: new Date(latestActivity).toISOString(), activityWindowMinutes },
      "legacy server is in active use (records created/updated within the activity window) — aborting. Re-run when the server is idle, or raise MIGRATION_ACTIVITY_WINDOW_MINUTES to override.",
    );
    process.exit(1);
  }

  const liveItems = itemRows.filter((row) => !isSoftDeleted(row));
  const liveCustomers = customerRows.filter((row) => !isSoftDeleted(row));
  const liveVendors = vendorRows.filter((row) => !isSoftDeleted(row));
  const liveInvoices = invoiceRows.filter((row) => !isSoftDeleted(row));
  const livePaymentsReceived = paymentReceivedRows.filter((row) => !isSoftDeleted(row));
  const liveBills = billRows.filter((row) => !isSoftDeleted(row));
  const livePaymentsMade = paymentMadeRows.filter((row) => !isSoftDeleted(row));
  const liveReturns = returnRows.filter((row) => !isSoftDeleted(row));
  const liveSfCustomers = sfCustomerRows.filter((row) => !isSoftDeleted(row));
  const liveAddresses = addressRows.filter((row) => !isSoftDeleted(row));
  const liveSfOrders = sfOrderRows.filter((row) => !isSoftDeleted(row));
  const liveTracking = trackingRows.filter((row) => !isSoftDeleted(row));
  report.skippedSoftDeleted =
    itemRows.length - liveItems.length +
    customerRows.length - liveCustomers.length +
    vendorRows.length - liveVendors.length +
    invoiceRows.length - liveInvoices.length +
    paymentReceivedRows.length - livePaymentsReceived.length +
    billRows.length - liveBills.length +
    paymentMadeRows.length - livePaymentsMade.length +
    returnRows.length - liveReturns.length +
    sfCustomerRows.length - liveSfCustomers.length +
    addressRows.length - liveAddresses.length +
    sfOrderRows.length - liveSfOrders.length +
    trackingRows.length - liveTracking.length;

  report.sourceCollections =
    orgRows.length + currencyRows.length + userRows.length + taxRows.length + groupRows.length + itemRows.length +
    customerRows.length + sfCustomerRows.length + addressRows.length + vendorRows.length + invoiceRows.length +
    invoiceItemRows.length + paymentReceivedRows.length + billRows.length + billItemRows.length +
    paymentMadeRows.length + returnRows.length + returnItemRows.length + sfOrderRows.length + orderItemRows.length +
    trackingRows.length;

  log.info(
    {
      organisations: orgRows.length,
      currencies: currencyRows.length,
      users: userRows.length,
      taxRates: taxRows.length,
      itemGroups: groupRows.length,
      items: liveItems.length,
      customers: liveCustomers.length,
      storefrontCustomers: liveSfCustomers.length,
      addresses: liveAddresses.length,
      vendors: liveVendors.length,
      invoices: liveInvoices.length,
      invoiceItems: invoiceItemRows.length,
      paymentsReceived: livePaymentsReceived.length,
      bills: liveBills.length,
      billItems: billItemRows.length,
      paymentsMade: livePaymentsMade.length,
      returns: liveReturns.length,
      returnItems: returnItemRows.length,
      storefrontOrders: liveSfOrders.length,
      orderItems: orderItemRows.length,
      tracking: liveTracking.length,
      softDeleted: report.skippedSoftDeleted,
    },
    "legacy data fetched",
  );

  const org = orgRows[0];
  if (!org) {
    log.error("no organisation found in legacy DB");
    process.exit(1);
  }

  report.skippedImages = liveItems.filter((item) => item.image !== "").length;

  // ── One transaction: every insert is sync (T1 — network is all above) ─────
  const started = Date.now();
  await withTx((tx) => {
    // Guard: the target must be empty.
    const existingSettings = tx.select({ id: settings.id }).from(settings).limit(1).get();
    const existingOutlet = tx.select({ id: outlets.id }).from(outlets).limit(1).get();
    const existingProduct = tx.select({ id: products.id }).from(products).limit(1).get();
    const existingUser = tx.select({ id: user.id }).from(user).limit(1).get();
    if (existingSettings || existingOutlet || existingProduct || existingUser) {
      throw new Error("target DB already contains data — refusing to migrate into it (use a fresh DATABASE_PATH)");
    }

    const now = Date.now();
    const orgCreated = ts(org.created, now);
    const orgUpdated = ts(org.updated, orgCreated);

    // ── 1. Outlet + settings ────────────────────────────────────────────────
    const outletId = randomUUIDv7();
    tx.insert(outlets)
      .values({ id: outletId, name: org.name, isActive: 1, createdAt: orgCreated, updatedAt: orgUpdated })
      .run();
    const currencyByLegacyId = new Map(currencyRows.map((c) => [c.id, c.code]));
    tx.insert(settings)
      .values({
        id: "singleton",
        orgName: org.name,
        gstin: org.gstin !== "" ? org.gstin : null,
        fiscalYearStartMonth: org.fiscal_year_start_month > 0 ? org.fiscal_year_start_month : 4,
        currency: currencyByLegacyId.get(org.base_currency) ?? "INR",
        timezone: org.timezone !== "" ? org.timezone : "Asia/Kolkata",
        defaultOutletId: outletId,
        createdAt: orgCreated,
        updatedAt: orgUpdated,
      })
      .run();

    // ── 2. Role + users + staff ─────────────────────────────────────────────
    const existingAdminRole = tx.select({ id: roles.id }).from(roles).where(eq(roles.name, "Admin")).get();
    const adminRoleId = existingAdminRole
      ? existingAdminRole.id
      : (() => {
          const roleId = randomUUIDv7();
          tx.insert(roles)
            .values({
              id: roleId,
              name: "Admin",
              capabilities: [...ALL_CAPABILITIES],
              scope: "global",
              outletId: null,
              createdAt: orgCreated,
              updatedAt: orgUpdated,
            })
            .run();
          counts.roles += 1;
          return roleId;
        })();

    const userIdByLegacy = new Map<string, string>();
    let adminUserRow: LUser | null = null;
    for (const legacyUser of userRows) {
      const userId = randomUUIDv7();
      const userCreated = ts(legacyUser.created, ts(legacyUser.updated, orgCreated));
      const userUpdated = ts(legacyUser.updated, userCreated);
      // user/account timestamps are drizzle `timestamp_ms` mode → Date values.
      const userCreatedAt = new Date(userCreated);
      const userUpdatedAt = new Date(userUpdated);
      tx.insert(user)
        .values({
          id: userId,
          name: legacyUser.name,
          email: legacyUser.email,
          emailVerified: legacyUser.verified,
          image: null,
          createdAt: userCreatedAt,
          updatedAt: userUpdatedAt,
        })
        .run();
      tx.insert(account)
        .values({
          id: randomUUIDv7(),
          userId,
          accountId: userId,
          providerId: "credential",
          accessToken: null,
          refreshToken: null,
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          scope: null,
          idToken: null,
          password: null,
          createdAt: userCreatedAt,
          updatedAt: userUpdatedAt,
        })
        .run();
      userIdByLegacy.set(legacyUser.id, userId);
      counts.users += 1;
      counts.accounts += 1;
      if (legacyUser.email === "admin@dalzo.in") adminUserRow = legacyUser;
    }

    if (adminUserRow) {
      const adminUserId = userIdByLegacy.get(adminUserRow.id)!;
      tx.insert(staffProfiles)
        .values({
          id: randomUUIDv7(),
          userId: adminUserId,
          outletId,
          roleId: adminRoleId,
          phone: adminUserRow.phone !== "" ? adminUserRow.phone : null,
          isActive: 1,
          isProtected: 0,
          createdAt: ts(adminUserRow.updated, orgCreated),
          updatedAt: ts(adminUserRow.updated, orgCreated),
        })
        .run();
      counts.staffProfiles += 1;
    }

    // ── 3. Categories ───────────────────────────────────────────────────────
    const categoryIdByLegacy = new Map<string, string>();
    for (const group of groupRows) {
      const id = randomUUIDv7();
      const createdAt = ts(group.created, orgCreated);
      const updatedAt = ts(group.updated, createdAt);
      tx.insert(categories)
        .values({ id, name: group.name, parentId: null, isActive: 1, createdAt, updatedAt })
        .run();
      categoryIdByLegacy.set(group.id, id);
      counts.categories += 1;
    }

    // ── 4. Products + variants ──────────────────────────────────────────────
    const taxRatePctByLegacyId = new Map(taxRows.map((t) => [t.id, t.rate]));
    const usedSlugs = new Set<string>();
    const usedSkus = new Set<string>();
    const itemVariantId = new Map<string, string>();
    const productIdByLegacyItemId = new Map<string, string>();

    function uniqueSlug(name: string): string {
      const base = slugifyName(name);
      let slug = base;
      for (let n = 2; usedSlugs.has(slug); n++) slug = `${base}-${n}`;
      if (slug !== base) report.duplicateSlugs += 1;
      usedSlugs.add(slug);
      return slug;
    }

    function uniqueSku(sku: string): string | null {
      if (sku === "" || usedSkus.has(sku)) {
        if (sku !== "") report.duplicateSkus += 1;
        return null;
      }
      usedSkus.add(sku);
      return sku;
    }

    function insertProductAndBaseVariant(item: LItem): void {
      const productId = randomUUIDv7();
      const variantId = randomUUIDv7();
      const sellingPricePaise = paise(item.selling_price);
      const createdAt = ts(item.created, orgCreated);
      const updatedAt = ts(item.updated, createdAt);
      const gstRatePct = item.tax_rate !== "" ? (taxRatePctByLegacyId.get(item.tax_rate) ?? 0) : 0;
      tx.insert(products)
        .values({
          id: productId,
          categoryId: item.item_group !== "" ? categoryIdByLegacy.get(item.item_group) ?? null : null,
          name: item.name,
          slug: uniqueSlug(item.name),
          hsnCode: item.hsn_code ?? "",
          gstRatePct,
          isActive: 1,
          createdAt,
          updatedAt,
        })
        .run();
      tx.insert(variants)
        .values({
          id: variantId,
          productId,
          name: item.name !== "" ? item.name : item.name,
          sku: uniqueSku(item.sku ?? ""),
          barcode: null,
          costPricePaise: paise(item.purchase_price),
          sellingPricePaise,
          mrpPaise: paise(item.mrp) > 0 ? paise(item.mrp) : sellingPricePaise,
          isBase: 1,
          isTaxable: item.tax_rate !== "" ? 1 : 0,
          isCustomerVisible: item.is_sellable ? 1 : 0,
          isActive: 1,
          createdAt,
          updatedAt,
        })
        .run();
      itemVariantId.set(item.id, variantId);
      productIdByLegacyItemId.set(item.id, productId);
      counts.products += 1;
      counts.variants += 1;
    }

    function insertChildVariant(item: LItem): void {
      const parentProductId = productIdByLegacyItemId.get(item.parent_item);
      if (!parentProductId) {
        report.skips.push(`item ${item.id} (${item.name}): parent ${item.parent_item} not found — treated as base`);
        insertProductAndBaseVariant(item);
        return;
      }
      const variantId = randomUUIDv7();
      const sellingPricePaise = paise(item.selling_price);
      const createdAt = ts(item.created, orgCreated);
      const updatedAt = ts(item.updated, createdAt);
      tx.insert(variants)
        .values({
          id: variantId,
          productId: parentProductId,
          name: item.name !== "" ? item.name : item.name,
          sku: uniqueSku(item.sku ?? ""),
          barcode: null,
          costPricePaise: paise(item.purchase_price),
          sellingPricePaise,
          mrpPaise: paise(item.mrp) > 0 ? paise(item.mrp) : sellingPricePaise,
          isBase: 0,
          isTaxable: item.tax_rate !== "" ? 1 : 0,
          isCustomerVisible: item.is_sellable ? 1 : 0,
          isActive: 1,
          createdAt,
          updatedAt,
        })
        .run();
      itemVariantId.set(item.id, variantId);
      productIdByLegacyItemId.set(item.id, parentProductId);
      counts.variants += 1;
    }

    const baseItems = liveItems.filter((item) => item.parent_item === "");
    const childItems = liveItems.filter((item) => item.parent_item !== "");
    for (const item of baseItems) insertProductAndBaseVariant(item);
    for (const item of childItems) insertChildVariant(item);

    // ── 5. Customers (legacy + storefront, phone-deduped) ───────────────────
    const customerIdByLegacy = new Map<string, string>();
    const customerIdByPhone = new Map<string, string>();
    const userIdByCustomer = new Map<string, string>();

    for (const legacyCustomer of liveCustomers) {
      const id = randomUUIDv7();
      const createdAt = ts(legacyCustomer.created, orgCreated);
      const updatedAt = ts(legacyCustomer.updated, createdAt);
      const phone = legacyCustomer.phone !== "" ? legacyCustomer.phone : null;
      const phoneTaken = phone !== null && customerIdByPhone.has(phone);
      if (phoneTaken) report.duplicatePhones += 1;
      tx.insert(customers)
        .values({
          id,
          userId: null,
          name: legacyCustomer.display_name !== "" ? legacyCustomer.display_name : legacyCustomer.name,
          phone: phoneTaken ? null : phone,
          gstin: legacyCustomer.gstin !== "" ? legacyCustomer.gstin : null,
          isActive: 1,
          createdAt,
          updatedAt,
        })
        .run();
      customerIdByLegacy.set(legacyCustomer.id, id);
      if (phone && !phoneTaken) customerIdByPhone.set(phone, id);
      counts.customers += 1;
    }

    for (const sfCustomer of liveSfCustomers) {
      const phone = sfCustomer.phone !== "" ? sfCustomer.phone : null;
      const existing = phone ? customerIdByPhone.get(phone) : undefined;
      const id = existing ?? randomUUIDv7();
      if (!existing) {
        const createdAt = ts(sfCustomer.created, orgCreated);
        const updatedAt = ts(sfCustomer.updated, createdAt);
        tx.insert(customers)
          .values({
            id,
            userId: null,
            name: sfCustomer.name !== "" ? sfCustomer.name : sfCustomer.phone,
            phone,
            gstin: null,
            isActive: 1,
            createdAt,
            updatedAt,
          })
          .run();
        counts.customers += 1;
      } else {
        report.skips.push(`storefront customer ${sfCustomer.id} (${sfCustomer.phone}): merged into customer ${id} by phone`);
      }
      customerIdByLegacy.set(sfCustomer.id, id);
      if (phone) customerIdByPhone.set(phone, id);
      if (sfCustomer.user !== "") {
        const userId = userIdByLegacy.get(sfCustomer.user);
        if (userId && !userIdByCustomer.has(userId)) {
          tx.update(customers)
            .set({ userId, updatedAt: Date.now() })
            .where(eq(customers.id, id))
            .run();
          userIdByCustomer.set(userId, id);
        }
      }
    }

    // ── 6. Addresses ────────────────────────────────────────────────────────
    for (const address of liveAddresses) {
      const customerId = customerIdByLegacy.get(address.customer);
      if (!customerId) {
        report.skips.push(`address ${address.id}: customer ${address.customer} not mapped`);
        continue;
      }
      tx.insert(custAddresses)
        .values({
          id: randomUUIDv7(),
          customerId,
          label: address.label !== "" ? address.label : "Home",
          line1: address.address_line1,
          line2: address.address_line2 !== "" ? address.address_line2 : null,
          city: address.city !== "" ? address.city : "",
          state: address.state !== "" ? address.state : "",
          pincode: address.postal_code !== "" ? address.postal_code : "",
        })
        .run();
      counts.custAddresses += 1;
    }

    // ── 7. Vendors ──────────────────────────────────────────────────────────
    const vendorIdByLegacy = new Map<string, string>();
    for (const vendor of liveVendors) {
      const id = randomUUIDv7();
      const createdAt = ts(vendor.created, orgCreated);
      const updatedAt = ts(vendor.updated, createdAt);
      tx.insert(vendors)
        .values({
          id,
          name: vendor.name,
          phone: vendor.phone !== "" ? vendor.phone : "",
          gstin: vendor.gstin !== "" ? vendor.gstin : null,
          isActive: 1,
          createdAt,
          updatedAt,
        })
        .run();
      vendorIdByLegacy.set(vendor.id, id);
      counts.vendors += 1;
    }

    // ── 8. Invoices → orders + invoices + lines + charges ───────────────────
    // Legacy document numbers are not guaranteed unique (PB enforces nothing):
    // keep the legacy number when free, otherwise draw a fresh one and count.
    const takenNumbers = new Set<string>();
    const isTaken = (candidate: string): boolean => takenNumbers.has(candidate);
    const uniqueNumber = (legacyNumber: string, prefix: string): string => {
      if (legacyNumber !== "" && !takenNumbers.has(legacyNumber)) {
        takenNumbers.add(legacyNumber);
        return legacyNumber;
      }
      const value = freshDocNumber(prefix, isTaken);
      takenNumbers.add(value);
      report.renamedDocumentNumbers += 1;
      return value;
    };
    // Numbers are claimed in insert order (invoices → bills → payments →
    // returns → storefront orders); a legacy number that collides with an
    // already-claimed one is renamed to a fresh `<prefix>-<base32>`.

    const invoiceItemIdByLegacy = new Map<string, string>();
    const orderIdByLegacyInvoiceId = new Map<string, string>();
    const invoiceIdByLegacyInvoiceId = new Map<string, string>();
    const lineIdByInvoiceAndVariant = new Map<string, string>();

    for (const legacyInvoice of liveInvoices) {
      const lines: (typeof invoiceItems.$inferInsert)[] = [];
      for (const line of invoiceItemRows.filter((l) => l.invoice === legacyInvoice.id)) {
        const variantId = itemVariantId.get(line.item);
        if (!variantId) {
          report.skips.push(`invoice ${legacyInvoice.invoice_number}: item ${line.item} not mapped — line skipped`);
          continue;
        }
        const item = liveItems.find((i) => i.id === line.item);
        const quantity = Math.round(line.quantity);
        if (Math.abs(line.quantity - quantity) > 1e-9) report.fractionalQuantities += 1;
        const lineId = randomUUIDv7();
        lines.push({
          id: lineId,
          invoiceId: "",
          variantId,
          name: item ? item.name : "",
          quantity,
          unitPricePaise: paise(line.rate),
          taxRatePct: line.tax_rate !== "" ? (taxRatePctByLegacyId.get(line.tax_rate) ?? 0) : 0,
          taxAmountPaise: paise(line.tax_amount),
          lineTotalPaise: paise(line.amount),
          isCustomItem: 0,
          allocations: [],
        });
        invoiceItemIdByLegacy.set(line.id, lineId);
      }

      const subtotalPaise = lines.reduce((sum, l) => sum + l.lineTotalPaise - l.taxAmountPaise, 0);
      const taxPaise = lines.reduce((sum, l) => sum + l.taxAmountPaise, 0);
      const charges = buildCharges(legacyInvoice.discount, legacyInvoice.round_off, legacyInvoice.extra_charges);
      const chargeTotal = charges.reduce((sum, c) => sum + c.amountPaise, 0);
      const totalPaise = subtotalPaise + taxPaise + chargeTotal;
      if (paise(legacyInvoice.total) !== totalPaise) report.invoiceTotalsDrift += 1;

      const orderId = randomUUIDv7();
      const invoiceId = randomUUIDv7();
      const customerId = customerIdByLegacy.get(legacyInvoice.customer) ?? null;
      const createdAt = ts(legacyInvoice.created, orgCreated);
      const updatedAt = ts(legacyInvoice.updated, createdAt);
      const issued =
        legacyInvoice.status === "sent" ||
        legacyInvoice.status === "paid" ||
        legacyInvoice.status === "partial" ||
        legacyInvoice.status === "overdue";

      tx.insert(orders)
        .values({
          id: orderId,
          orderNumber: freshDocNumber("OR", isTaken),
          orderType: "manual",
          customerId,
          outletId,
          status: issued ? "confirmed" : "cancelled",
          totalPaise,
          version: 1,
          createdAt,
          updatedAt,
        })
        .run();
      tx.insert(invoices)
        .values({
          id: invoiceId,
          invoiceNumber: uniqueNumber(legacyInvoice.invoice_number, "INV"),
          orderId,
          customerId,
          outletId,
          status: issued ? "issued" : "void",
          subtotalPaise,
          taxPaise,
          totalPaise,
          pdfPath: null,
          supersedesId: null,
          version: 1,
          createdAt,
          updatedAt,
        })
        .run();
      for (const line of lines) {
        tx.insert(invoiceItems).values({ ...line, invoiceId }).run();
        counts.invoiceItems += 1;
        lineIdByInvoiceAndVariant.set(`${invoiceId}:${line.variantId}`, line.id);
      }
      for (const charge of charges) {
        tx.insert(invoiceCharges)
          .values({ id: randomUUIDv7(), invoiceId, name: charge.name, amountPaise: charge.amountPaise })
          .run();
        counts.invoiceCharges += 1;
      }
      orderIdByLegacyInvoiceId.set(legacyInvoice.id, orderId);
      invoiceIdByLegacyInvoiceId.set(legacyInvoice.id, invoiceId);
      counts.ordersManual += 1;
      counts.invoicesManual += 1;
    }

    // ── 9. Bills → purchase_bills + lines + charges ─────────────────────────
    const billIdByLegacy = new Map<string, string>();
    for (const legacyBill of liveBills) {
      const vendorId = vendorIdByLegacy.get(legacyBill.vendor);
      if (!vendorId) {
        report.skips.push(`bill ${legacyBill.bill_number}: vendor ${legacyBill.vendor} not mapped — bill skipped`);
        continue;
      }
      const lines: (typeof purchaseBillItems.$inferInsert)[] = [];
      for (const line of billItemRows.filter((l) => l.bill === legacyBill.id)) {
        const variantId = itemVariantId.get(line.item);
        if (!variantId) {
          report.skips.push(`bill ${legacyBill.bill_number}: item ${line.item} not mapped — line skipped`);
          continue;
        }
        const quantity = Math.round(line.quantity);
        if (Math.abs(line.quantity - quantity) > 1e-9) report.fractionalQuantities += 1;
        lines.push({
          id: randomUUIDv7(),
          purchaseBillId: "",
          variantId,
          batchId: null,
          batchNumber: null,
          quantity,
          unitCostPaise: paise(line.rate),
          taxRatePct: line.tax_rate !== "" ? (taxRatePctByLegacyId.get(line.tax_rate) ?? 0) : 0,
          taxAmountPaise: paise(line.tax_amount),
          lineTotalPaise: paise(line.amount),
        });
      }
      const subtotalPaise = lines.reduce((sum, l) => sum + l.lineTotalPaise - l.taxAmountPaise, 0);
      const taxPaise = lines.reduce((sum, l) => sum + l.taxAmountPaise, 0);
      const charges = buildCharges(legacyBill.discount, legacyBill.round_off, legacyBill.extra_charges);
      const chargeTotal = charges.reduce((sum, c) => sum + c.amountPaise, 0);
      const totalPaise = subtotalPaise + taxPaise + chargeTotal;
      if (paise(legacyBill.total) !== totalPaise) report.billTotalsDrift += 1;

      const billId = randomUUIDv7();
      const createdAt = ts(legacyBill.created, orgCreated);
      const updatedAt = ts(legacyBill.updated, createdAt);
      const issued =
        legacyBill.status === "open" ||
        legacyBill.status === "paid" ||
        legacyBill.status === "partial" ||
        legacyBill.status === "overdue";

      tx.insert(purchaseBills)
        .values({
          id: billId,
          billNumber: uniqueNumber(legacyBill.bill_number, "BILL"),
          vendorId,
          outletId,
          status: issued ? "issued" : "void",
          subtotalPaise,
          taxPaise,
          totalPaise,
          version: 1,
          createdAt,
          updatedAt,
        })
        .run();
      for (const line of lines) {
        tx.insert(purchaseBillItems).values({ ...line, purchaseBillId: billId }).run();
        counts.purchaseBillItems += 1;
      }
      for (const charge of charges) {
        tx.insert(billCharges)
          .values({ id: randomUUIDv7(), purchaseBillId: billId, name: charge.name, amountPaise: charge.amountPaise })
          .run();
        counts.billCharges += 1;
      }
      billIdByLegacy.set(legacyBill.id, billId);
      counts.purchaseBills += 1;
    }

    // ── 10. Payments ────────────────────────────────────────────────────────
    for (const payment of livePaymentsReceived) {
      if (payment.invoice === "") {
        report.skippedOrphanPayments += 1;
        report.skips.push(
          `payment ${payment.payment_number}: no linked invoice — skipped (payments is insert-only in the new schema; an orphan cannot be created or linked later)`,
        );
        continue;
      }
      const customerId = customerIdByLegacy.get(payment.customer);
      const invoiceId = invoiceIdByLegacyInvoiceId.get(payment.invoice);
      if (!customerId || !invoiceId) {
        report.skips.push(`payment ${payment.payment_number}: customer/invoice not mapped — skipped`);
        continue;
      }
      tx.insert(payments)
        .values({
          id: randomUUIDv7(),
          paymentNumber: uniqueNumber(payment.payment_number, "PY"),
          direction: "in",
          partyType: "customer",
          partyId: customerId,
          invoiceId,
          purchaseBillId: null,
          returnId: null,
          outletId,
          amountPaise: paise(payment.amount),
          mode: PAYMENT_MODE_MAP[payment.payment_mode] ?? "cash",
          gateway: null,
          gatewayPaymentId: null,
          gatewayEventId: null,
          status: "confirmed",
          createdAt: ts(payment.payment_date, ts(payment.created, orgCreated)),
        })
        .run();
      counts.payments += 1;
    }
    for (const payment of livePaymentsMade) {
      const vendorId = vendorIdByLegacy.get(payment.vendor);
      const billId = billIdByLegacy.get(payment.bill);
      if (!vendorId || !billId) {
        report.skips.push(`payment ${payment.payment_number}: vendor/bill not mapped — skipped`);
        continue;
      }
      tx.insert(payments)
        .values({
          id: randomUUIDv7(),
          paymentNumber: uniqueNumber(payment.payment_number, "PY"),
          direction: "out",
          partyType: "vendor",
          partyId: vendorId,
          invoiceId: null,
          purchaseBillId: billId,
          returnId: null,
          outletId,
          amountPaise: paise(payment.amount),
          mode: PAYMENT_MODE_MAP[payment.payment_mode] ?? "cash",
          gateway: null,
          gatewayPaymentId: null,
          gatewayEventId: null,
          status: "confirmed",
          createdAt: ts(payment.payment_date, ts(payment.created, orgCreated)),
        })
        .run();
      counts.payments += 1;
    }

    // ── 11. Sales returns ───────────────────────────────────────────────────
    for (const legacyReturn of liveReturns) {
      const returnId = randomUUIDv7();
      const createdAt = ts(legacyReturn.created, orgCreated);
      const updatedAt = ts(legacyReturn.updated, createdAt);
      const orderId = orderIdByLegacyInvoiceId.get(legacyReturn.invoice) ?? null;
      tx.insert(returns)
        .values({
          id: returnId,
          returnNumber: uniqueNumber(legacyReturn.return_number, "SRET"),
          returnType: "sales",
          orderId,
          purchaseBillId: null,
          outletId,
          status: legacyReturn.status === "void" ? "void" : legacyReturn.status === "draft" ? "draft" : "confirmed",
          version: 1,
          createdAt,
          updatedAt,
        })
        .run();
      counts.returns += 1;

      const invoiceId = invoiceIdByLegacyInvoiceId.get(legacyReturn.invoice);
      for (const line of returnItemRows.filter((l) => l.sales_return === legacyReturn.id)) {
        const variantId = itemVariantId.get(line.item);
        if (!variantId) {
          report.skips.push(`return ${legacyReturn.return_number}: item ${line.item} not mapped — line skipped`);
          continue;
        }
        // Legacy return lines do not reference the original invoice line —
        // match by (invoice, item) against the migrated invoice_items.
        const originalItemId = invoiceId ? lineIdByInvoiceAndVariant.get(`${invoiceId}:${variantId}`) : undefined;
        if (!originalItemId) {
          report.skips.push(
            `return ${legacyReturn.return_number}: no invoice line found for item ${line.item} — line skipped`,
          );
          continue;
        }
        tx.insert(returnItems)
          .values({
            id: randomUUIDv7(),
            returnId,
            variantId,
            originalItemId,
            quantity: Math.round(line.quantity),
            unitPricePaise: paise(line.rate),
            taxAmountPaise: paise(line.tax_amount),
          })
          .run();
        counts.returnItems += 1;
      }
    }

    // ── 12. Storefront orders → orders + invoices + payments ────────────────
    const orderIdByLegacySfOrderId = new Map<string, string>();
    for (const sfOrder of liveSfOrders) {
      const customerId = customerIdByLegacy.get(sfOrder.customer);
      if (!customerId) {
        report.skips.push(`storefront order ${sfOrder.order_number}: customer ${sfOrder.customer} not mapped — order skipped`);
        continue;
      }
      const createdAt = ts(sfOrder.created, orgCreated);
      const updatedAt = ts(sfOrder.updated, createdAt);
      const orderStatus =
        sfOrder.status === "cancelled"
          ? "cancelled"
          : sfOrder.status === "payment_pending" || sfOrder.status === "browsing" || sfOrder.status === "cart"
            ? "pending"
            : "confirmed";

      const lines: (typeof invoiceItems.$inferInsert)[] = [];
      for (const line of orderItemRows.filter((l) => l.order === sfOrder.id)) {
        const variantId = itemVariantId.get(line.item);
        if (!variantId) {
          report.skips.push(`storefront order ${sfOrder.order_number}: item ${line.item} not mapped — line skipped`);
          continue;
        }
        const item = liveItems.find((i) => i.id === line.item);
        const quantity = Math.round(line.quantity);
        if (Math.abs(line.quantity - quantity) > 1e-9) report.fractionalQuantities += 1;
        lines.push({
          id: randomUUIDv7(),
          invoiceId: "",
          variantId,
          name: line.item_name !== "" ? line.item_name : item ? item.name : "",
          quantity,
          unitPricePaise: paise(line.selling_price),
          taxRatePct: item && item.tax_rate !== "" ? (taxRatePctByLegacyId.get(item.tax_rate) ?? 0) : 0,
          taxAmountPaise: 0,
          lineTotalPaise: paise(line.total),
          isCustomItem: 0,
          allocations: [],
        });
      }

      const subtotalPaise = lines.reduce((sum, l) => sum + l.lineTotalPaise, 0);
      const charges = buildCharges(sfOrder.discount, 0, null);
      if (numberOrZero(sfOrder.shipping_charge) > 0) {
        charges.push({ name: "Shipping", amountPaise: paise(sfOrder.shipping_charge) });
      }
      const chargeTotal = charges.reduce((sum, c) => sum + c.amountPaise, 0);
      const totalPaise = subtotalPaise + chargeTotal;

      const orderId = randomUUIDv7();
      tx.insert(orders)
        .values({
          id: orderId,
          orderNumber: uniqueNumber(sfOrder.order_number, "ORD"),
          orderType: "storefront",
          customerId,
          outletId,
          status: orderStatus,
          totalPaise,
          version: 1,
          createdAt,
          updatedAt,
        })
        .run();
      orderIdByLegacySfOrderId.set(sfOrder.id, orderId);
      counts.ordersStorefront += 1;

      const invoiceId = randomUUIDv7();
      const paid = sfOrder.payment_status === "paid";
      tx.insert(invoices)
        .values({
          id: invoiceId,
          invoiceNumber: freshDocNumber("INV", isTaken),
          orderId,
          customerId,
          outletId,
          status: paid ? "issued" : "draft",
          subtotalPaise,
          taxPaise: 0,
          totalPaise,
          pdfPath: null,
          supersedesId: null,
          version: 1,
          createdAt,
          updatedAt,
        })
        .run();
      counts.invoicesStorefront += 1;
      for (const line of lines) {
        tx.insert(invoiceItems).values({ ...line, invoiceId }).run();
        counts.storefrontInvoiceItems += 1;
      }
      for (const charge of charges) {
        tx.insert(invoiceCharges)
          .values({ id: randomUUIDv7(), invoiceId, name: charge.name, amountPaise: charge.amountPaise })
          .run();
        counts.storefrontInvoiceCharges += 1;
      }

      const amountPaise = paid ? paise(sfOrder.amount_paid) : totalPaise;
      tx.insert(payments)
        .values({
          id: randomUUIDv7(),
          paymentNumber: freshDocNumber("PY", isTaken),
          direction: "in",
          partyType: "customer",
          partyId: customerId,
          invoiceId,
          purchaseBillId: null,
          returnId: null,
          outletId,
          amountPaise,
          mode: "gateway",
          gateway: null,
          gatewayPaymentId: sfOrder.payment_order_id !== "" ? sfOrder.payment_order_id : null,
          gatewayEventId: null,
          status: paid ? "confirmed" : "pending",
          createdAt,
        })
        .run();
      counts.payments += 1;
      counts.storefrontPayments += 1;
    }

    // ── 13. Order tracking → order_events ───────────────────────────────────
    for (const track of liveTracking) {
      const orderId = orderIdByLegacySfOrderId.get(track.order);
      if (!orderId) {
        report.skips.push(`tracking ${track.id}: storefront order ${track.order} not mapped — skipped`);
        continue;
      }
      tx.insert(orderEvents)
        .values({
          id: randomUUIDv7(),
          orderId,
          type: `order.${track.status}`,
          payload: { note: track.note, isAdminNote: track.is_admin_note },
          actorId: null,
          actorType: track.is_admin_note ? "staff" : "customer",
          createdAt: ts(track.created, orgCreated),
        })
        .run();
      counts.orderEvents += 1;
    }
  });

  const elapsed = Date.now() - started;
  log.info(
    {
      elapsedMs: elapsed,
      sourceCollections: report.sourceCollections,
      targetRows: Object.values(counts).reduce((sum, n) => sum + n, 0),
      counts,
      skippedSoftDeleted: report.skippedSoftDeleted,
      skippedOrphanPayments: report.skippedOrphanPayments,
      duplicateSlugs: report.duplicateSlugs,
      duplicateSkus: report.duplicateSkus,
      duplicatePhones: report.duplicatePhones,
      fractionalQuantities: report.fractionalQuantities,
      renamedDocumentNumbers: report.renamedDocumentNumbers,
      invoiceTotalsDrift: report.invoiceTotalsDrift,
      billTotalsDrift: report.billTotalsDrift,
      skippedImages: report.skippedImages,
      skips: report.skips.length,
    },
    "migration complete",
  );
  if (report.skips.length > 0) {
    log.warn({ skips: report.skips }, "skipped rows");
  }
  log.warn(
    "legacy user passwords were NOT migrated (PB bcrypt is not portable to better-auth) — migrated users must use the password-reset flow before they can sign in",
  );
  log.warn(
    "not migrated (no target table in the new schema): partners, partner_investments, partner_commitments, item_conversions, credit_notes, vendor_credits, purchase_returns, inventory_adjustments",
  );
  log.warn("item images were NOT migrated (per request) — the media table is empty; re-upload images later via the app");
}

applyMigrations(db);
await main();