import { randomUUIDv7 } from "bun";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { logger } from "../lib/logger";
import { applyMigrations } from "../lib/migrate";

type FkSpec = {
  from: string;
  refTable: string;
  refColumn: string;
  onDelete: "restrict" | "cascade" | "no action";
};

type IndexSpec = {
  name: string;
  columns: string[];
  unique: boolean;
  partial: boolean;
};

type TableSpec = {
  columns: string[];
  fks?: FkSpec[];
  indexes?: IndexSpec[];
  compositePk?: string[];
};

const EXPECTED: Record<string, TableSpec> = {
  user: {
    columns: ["id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt"],
    indexes: [{ name: "user_email_unique", columns: ["email"], unique: true, partial: false }],
  },
  session: {
    columns: ["id", "userId", "token", "expiresAt", "ipAddress", "userAgent", "createdAt", "updatedAt"],
    fks: [{ from: "userId", refTable: "user", refColumn: "id", onDelete: "cascade" }],
    indexes: [
      { name: "session_token_unique", columns: ["token"], unique: true, partial: false },
      { name: "session_user_idx", columns: ["userId"], unique: false, partial: false },
    ],
  },
  account: {
    columns: ["id", "userId", "accountId", "providerId", "accessToken", "refreshToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "idToken", "password", "createdAt", "updatedAt"],
    fks: [{ from: "userId", refTable: "user", refColumn: "id", onDelete: "cascade" }],
    indexes: [
      { name: "account_provider_account_unique", columns: ["providerId", "accountId"], unique: true, partial: false },
      { name: "account_user_idx", columns: ["userId"], unique: false, partial: false },
    ],
  },
  verification: {
    columns: ["id", "identifier", "value", "expiresAt", "createdAt", "updatedAt"],
  },
  categories: {
    columns: ["id", "name", "parentId", "isActive", "createdAt", "updatedAt"],
    fks: [{ from: "parentId", refTable: "categories", refColumn: "id", onDelete: "restrict" }],
    indexes: [{ name: "categories_parent_id_idx", columns: ["parentId"], unique: false, partial: false }],
  },
  products: {
    columns: ["id", "categoryId", "name", "slug", "hsnCode", "gstRatePct", "isActive", "createdAt", "updatedAt"],
    fks: [{ from: "categoryId", refTable: "categories", refColumn: "id", onDelete: "restrict" }],
    indexes: [
      { name: "products_slug_unique", columns: ["slug"], unique: true, partial: false },
      { name: "products_category_id_idx", columns: ["categoryId"], unique: false, partial: false },
    ],
  },
  variants: {
    columns: ["id", "productId", "name", "sku", "barcode", "costPricePaise", "sellingPricePaise", "mrpPaise", "isBase", "isTaxable", "isCustomerVisible", "isActive", "createdAt", "updatedAt"],
    fks: [{ from: "productId", refTable: "products", refColumn: "id", onDelete: "restrict" }],
    indexes: [
      { name: "variants_sku_unique", columns: ["sku"], unique: true, partial: true },
      { name: "variants_barcode_unique", columns: ["barcode"], unique: true, partial: true },
      { name: "variants_product_id_is_base_unique", columns: ["productId"], unique: true, partial: true },
      { name: "variants_product_id_idx", columns: ["productId"], unique: false, partial: false },
    ],
  },
  batches: {
    columns: ["id", "variantId", "batchNumber", "expiryDate", "costPricePaise", "isActive", "createdAt"],
    fks: [{ from: "variantId", refTable: "variants", refColumn: "id", onDelete: "restrict" }],
    indexes: [{ name: "batches_variant_id_batch_number_unique", columns: ["variantId", "batchNumber"], unique: true, partial: false }],
  },
  customers: {
    columns: ["id", "userId", "name", "phone", "gstin", "isActive", "createdAt", "updatedAt"],
    fks: [{ from: "userId", refTable: "user", refColumn: "id", onDelete: "restrict" }],
    indexes: [
      { name: "customers_user_id_unique", columns: ["userId"], unique: true, partial: true },
      { name: "customers_phone_unique", columns: ["phone"], unique: true, partial: true },
    ],
  },
  cust_addresses: {
    columns: ["id", "customerId", "label", "line1", "line2", "city", "state", "pincode"],
    fks: [{ from: "customerId", refTable: "customers", refColumn: "id", onDelete: "cascade" }],
    indexes: [{ name: "cust_addresses_customer_id_idx", columns: ["customerId"], unique: false, partial: false }],
  },
  vendors: {
    columns: ["id", "name", "phone", "gstin", "isActive", "createdAt", "updatedAt"],
  },
  stock_levels: {
    columns: ["variantId", "outletId", "batchId", "quantity", "lastMovementId", "updatedAt"],
    compositePk: ["variantId", "outletId", "batchId"],
    fks: [
      { from: "variantId", refTable: "variants", refColumn: "id", onDelete: "restrict" },
      { from: "outletId", refTable: "outlets", refColumn: "id", onDelete: "restrict" },
      { from: "batchId", refTable: "batches", refColumn: "id", onDelete: "restrict" },
    ],
  },
  stock_movements: {
    columns: ["id", "variantId", "outletId", "batchId", "delta", "reason", "sourceType", "sourceId", "createdAt"],
    fks: [
      { from: "variantId", refTable: "variants", refColumn: "id", onDelete: "restrict" },
      { from: "outletId", refTable: "outlets", refColumn: "id", onDelete: "restrict" },
      { from: "batchId", refTable: "batches", refColumn: "id", onDelete: "restrict" },
    ],
    indexes: [
      { name: "stock_movements_variant_outlet_idx", columns: ["variantId", "outletId"], unique: false, partial: false },
      { name: "stock_movements_source_idx", columns: ["sourceType", "sourceId"], unique: false, partial: false },
    ],
  },
  stock_transfers: {
    columns: ["id", "transferNumber", "fromOutletId", "toOutletId", "status", "version", "createdAt", "updatedAt"],
    fks: [
      { from: "fromOutletId", refTable: "outlets", refColumn: "id", onDelete: "restrict" },
      { from: "toOutletId", refTable: "outlets", refColumn: "id", onDelete: "restrict" },
    ],
    indexes: [{ name: "stock_transfers_transfer_number_unique", columns: ["transferNumber"], unique: true, partial: false }],
  },
  stock_transfer_items: {
    columns: ["id", "stockTransferId", "variantId", "batchId", "quantity"],
    fks: [
      { from: "stockTransferId", refTable: "stock_transfers", refColumn: "id", onDelete: "cascade" },
      { from: "variantId", refTable: "variants", refColumn: "id", onDelete: "restrict" },
      { from: "batchId", refTable: "batches", refColumn: "id", onDelete: "restrict" },
    ],
    indexes: [{ name: "stock_transfer_items_transfer_idx", columns: ["stockTransferId"], unique: false, partial: false }],
  },
  adjustments: {
    columns: ["id", "adjustmentNumber", "outletId", "reason", "status", "version", "createdAt", "updatedAt"],
    fks: [{ from: "outletId", refTable: "outlets", refColumn: "id", onDelete: "restrict" }],
    indexes: [{ name: "adjustments_adjustment_number_unique", columns: ["adjustmentNumber"], unique: true, partial: false }],
  },
  adjustment_items: {
    columns: ["id", "adjustmentId", "variantId", "batchId", "quantity", "unitValuePaise"],
    fks: [
      { from: "adjustmentId", refTable: "adjustments", refColumn: "id", onDelete: "cascade" },
      { from: "variantId", refTable: "variants", refColumn: "id", onDelete: "restrict" },
      { from: "batchId", refTable: "batches", refColumn: "id", onDelete: "restrict" },
    ],
    indexes: [{ name: "adjustment_items_adjustment_idx", columns: ["adjustmentId"], unique: false, partial: false }],
  },
  purchase_bills: {
    columns: ["id", "billNumber", "vendorId", "outletId", "status", "subtotalPaise", "taxPaise", "totalPaise", "version", "createdAt", "updatedAt"],
    fks: [
      { from: "vendorId", refTable: "vendors", refColumn: "id", onDelete: "restrict" },
      { from: "outletId", refTable: "outlets", refColumn: "id", onDelete: "restrict" },
    ],
    indexes: [{ name: "purchase_bills_bill_number_unique", columns: ["billNumber"], unique: true, partial: false }],
  },
  purchase_bill_items: {
    columns: ["id", "purchaseBillId", "variantId", "batchId", "batchNumber", "quantity", "unitCostPaise", "taxRatePct", "taxAmountPaise", "lineTotalPaise"],
    fks: [
      { from: "purchaseBillId", refTable: "purchase_bills", refColumn: "id", onDelete: "cascade" },
      { from: "variantId", refTable: "variants", refColumn: "id", onDelete: "restrict" },
      { from: "batchId", refTable: "batches", refColumn: "id", onDelete: "restrict" },
    ],
    indexes: [{ name: "purchase_bill_items_bill_idx", columns: ["purchaseBillId"], unique: false, partial: false }],
  },
  bill_charges: {
    columns: ["id", "purchaseBillId", "name", "amountPaise"],
    fks: [{ from: "purchaseBillId", refTable: "purchase_bills", refColumn: "id", onDelete: "cascade" }],
    indexes: [{ name: "bill_charges_bill_idx", columns: ["purchaseBillId"], unique: false, partial: false }],
  },
  orders: {
    columns: ["id", "orderNumber", "orderType", "customerId", "outletId", "status", "totalPaise", "version", "createdAt", "updatedAt"],
    fks: [
      { from: "customerId", refTable: "customers", refColumn: "id", onDelete: "restrict" },
      { from: "outletId", refTable: "outlets", refColumn: "id", onDelete: "restrict" },
    ],
    indexes: [{ name: "orders_order_number_unique", columns: ["orderNumber"], unique: true, partial: false }],
  },
  invoices: {
    columns: ["id", "invoiceNumber", "orderId", "customerId", "outletId", "status", "subtotalPaise", "taxPaise", "totalPaise", "pdfPath", "supersedesId", "version", "createdAt", "updatedAt"],
    fks: [
      { from: "orderId", refTable: "orders", refColumn: "id", onDelete: "restrict" },
      { from: "customerId", refTable: "customers", refColumn: "id", onDelete: "restrict" },
      { from: "outletId", refTable: "outlets", refColumn: "id", onDelete: "restrict" },
      { from: "supersedesId", refTable: "invoices", refColumn: "id", onDelete: "restrict" },
    ],
    indexes: [{ name: "invoices_invoice_number_unique", columns: ["invoiceNumber"], unique: true, partial: false }],
  },
  invoice_items: {
    columns: ["id", "invoiceId", "variantId", "name", "quantity", "unitPricePaise", "taxRatePct", "taxAmountPaise", "lineTotalPaise", "isCustomItem", "allocations"],
    fks: [
      { from: "invoiceId", refTable: "invoices", refColumn: "id", onDelete: "cascade" },
      { from: "variantId", refTable: "variants", refColumn: "id", onDelete: "restrict" },
    ],
    indexes: [{ name: "invoice_items_invoice_idx", columns: ["invoiceId"], unique: false, partial: false }],
  },
  invoice_charges: {
    columns: ["id", "invoiceId", "name", "amountPaise"],
    fks: [{ from: "invoiceId", refTable: "invoices", refColumn: "id", onDelete: "cascade" }],
    indexes: [{ name: "invoice_charges_invoice_idx", columns: ["invoiceId"], unique: false, partial: false }],
  },
  returns: {
    columns: ["id", "returnNumber", "returnType", "orderId", "purchaseBillId", "outletId", "status", "version", "createdAt", "updatedAt"],
    fks: [
      { from: "orderId", refTable: "orders", refColumn: "id", onDelete: "restrict" },
      { from: "purchaseBillId", refTable: "purchase_bills", refColumn: "id", onDelete: "restrict" },
      { from: "outletId", refTable: "outlets", refColumn: "id", onDelete: "restrict" },
    ],
    indexes: [{ name: "returns_return_number_unique", columns: ["returnNumber"], unique: true, partial: false }],
  },
  return_items: {
    columns: ["id", "returnId", "variantId", "originalItemId", "quantity", "unitPricePaise", "taxAmountPaise"],
    fks: [
      { from: "returnId", refTable: "returns", refColumn: "id", onDelete: "cascade" },
      { from: "variantId", refTable: "variants", refColumn: "id", onDelete: "restrict" },
    ],
    indexes: [{ name: "return_items_return_idx", columns: ["returnId"], unique: false, partial: false }],
  },
  shipments: {
    columns: ["id", "shipmentNumber", "invoiceId", "carrier", "awbNumber", "status", "version", "createdAt", "updatedAt"],
    fks: [{ from: "invoiceId", refTable: "invoices", refColumn: "id", onDelete: "restrict" }],
    indexes: [
      { name: "shipments_shipment_number_unique", columns: ["shipmentNumber"], unique: true, partial: false },
      { name: "shipments_invoice_idx", columns: ["invoiceId"], unique: false, partial: false },
    ],
  },
  payments: {
    columns: ["id", "paymentNumber", "direction", "partyType", "partyId", "invoiceId", "purchaseBillId", "returnId", "outletId", "amountPaise", "mode", "gateway", "gatewayPaymentId", "gatewayEventId", "status", "createdAt"],
    fks: [
      { from: "invoiceId", refTable: "invoices", refColumn: "id", onDelete: "restrict" },
      { from: "purchaseBillId", refTable: "purchase_bills", refColumn: "id", onDelete: "restrict" },
      { from: "returnId", refTable: "returns", refColumn: "id", onDelete: "restrict" },
      { from: "outletId", refTable: "outlets", refColumn: "id", onDelete: "restrict" },
    ],
    indexes: [
      { name: "payments_payment_number_unique", columns: ["paymentNumber"], unique: true, partial: false },
      { name: "payments_gateway_event_unique", columns: ["gateway", "gatewayEventId"], unique: true, partial: true },
      { name: "payments_party_idx", columns: ["partyType", "partyId"], unique: false, partial: false },
      { name: "payments_invoice_idx", columns: ["invoiceId"], unique: false, partial: false },
      { name: "payments_purchase_bill_idx", columns: ["purchaseBillId"], unique: false, partial: false },
    ],
  },
  settings: {
    columns: ["id", "orgName", "gstin", "fiscalYearStartMonth", "currency", "timezone", "defaultOutletId", "createdAt", "updatedAt"],
    fks: [{ from: "defaultOutletId", refTable: "outlets", refColumn: "id", onDelete: "restrict" }],
  },
  outlets: {
    columns: ["id", "name", "isActive", "createdAt", "updatedAt"],
  },
  roles: {
    columns: ["id", "name", "capabilities", "scope", "outletId", "createdAt", "updatedAt"],
    fks: [{ from: "outletId", refTable: "outlets", refColumn: "id", onDelete: "restrict" }],
    indexes: [
      { name: "roles_name_unique", columns: ["name"], unique: true, partial: false },
      { name: "roles_scope_idx", columns: ["scope"], unique: false, partial: false },
    ],
  },
  staff_profiles: {
    columns: ["id", "userId", "outletId", "roleId", "phone", "isActive", "isProtected", "createdAt", "updatedAt"],
    fks: [
      { from: "userId", refTable: "user", refColumn: "id", onDelete: "restrict" },
      { from: "outletId", refTable: "outlets", refColumn: "id", onDelete: "restrict" },
      { from: "roleId", refTable: "roles", refColumn: "id", onDelete: "restrict" },
    ],
    indexes: [{ name: "staff_profiles_user_id_unique", columns: ["userId"], unique: true, partial: false }],
  },
  order_events: {
    columns: ["id", "orderId", "type", "payload", "actorId", "actorType", "createdAt"],
    fks: [{ from: "orderId", refTable: "orders", refColumn: "id", onDelete: "restrict" }],
    indexes: [{ name: "order_events_order_idx", columns: ["orderId", "createdAt"], unique: false, partial: false }],
  },
  audit_events: {
    columns: ["id", "entityType", "entityId", "action", "actorId", "actorType", "before", "after", "createdAt"],
    indexes: [
      { name: "audit_events_entity_idx", columns: ["entityType", "entityId"], unique: false, partial: false },
      { name: "audit_events_actor_idx", columns: ["actorId"], unique: false, partial: false },
    ],
  },
  media: {
    columns: ["id", "ownerType", "ownerId", "path", "thumbPath", "mimeType", "sizeBytes", "altText", "createdAt"],
    indexes: [{ name: "media_owner_idx", columns: ["ownerType", "ownerId"], unique: false, partial: false }],
  },
  cart_items: {
    columns: ["id", "customerId", "variantId", "quantity", "createdAt", "updatedAt"],
    fks: [
      { from: "customerId", refTable: "customers", refColumn: "id", onDelete: "restrict" },
      { from: "variantId", refTable: "variants", refColumn: "id", onDelete: "restrict" },
    ],
    indexes: [{ name: "cart_items_customer_variant_unique", columns: ["customerId", "variantId"], unique: true, partial: false }],
  },
  wishlist_items: {
    columns: ["id", "customerId", "variantId", "createdAt"],
    fks: [
      { from: "customerId", refTable: "customers", refColumn: "id", onDelete: "restrict" },
      { from: "variantId", refTable: "variants", refColumn: "id", onDelete: "restrict" },
    ],
    indexes: [{ name: "wishlist_items_customer_variant_unique", columns: ["customerId", "variantId"], unique: true, partial: false }],
  },
  idempotency_keys: {
    columns: ["id", "operation", "key", "requestHash", "responseSnapshot", "status", "createdAt", "expiresAt"],
    indexes: [
      { name: "idempotency_keys_operation_key_unique", columns: ["operation", "key"], unique: true, partial: false },
      { name: "idempotency_keys_expires_idx", columns: ["expiresAt"], unique: false, partial: false },
    ],
  },
};

const IMMUTABLE_TABLES = ["stock_movements", "payments", "order_events", "audit_events"];

type Row = Record<string, unknown>;

function assert(cond: boolean, msg: string, failures: string[]): void {
  if (!cond) failures.push(msg);
}

function main(): void {
  const log = logger.child({ module: "verify-db" });
  const tmpPath = join("data", `verify-db-${randomUUIDv7()}.sqlite`);
  const failures: string[] = [];

  mkdirSync(dirname(tmpPath), { recursive: true });
  const sqlite = new Database(tmpPath);
  try {
    sqlite.run("PRAGMA journal_mode = WAL;");
    sqlite.run("PRAGMA foreign_keys = ON;");
    const db = drizzle(sqlite);
    applyMigrations(db);

    const wal = sqlite.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!;
    assert(wal.journal_mode === "wal", `journal_mode is ${wal.journal_mode}, expected wal`, failures);

    const fkPragma = sqlite.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()!;
    assert(fkPragma.foreign_keys === 1, `foreign_keys pragma is ${fkPragma.foreign_keys}, expected 1`, failures);

    const actualTables = sqlite
      .query<Row, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name")
      .all()
      .map((r) => String(r.name));
    const expectedNames = Object.keys(EXPECTED).sort();
    assert(
      JSON.stringify(actualTables) === JSON.stringify(expectedNames),
      `table set mismatch: got [${actualTables.join(", ")}] expected [${expectedNames.join(", ")}]`,
      failures,
    );

    let indexCount = 0;
    let partialUniqueCount = 0;
    for (const tableName of expectedNames) {
      const spec = EXPECTED[tableName]!;

      const cols = sqlite.query<Row, []>(`PRAGMA table_info(\`${tableName}\`)`).all();
      const gotCols = cols.map((c) => String(c.name));
      assert(
        JSON.stringify(gotCols) === JSON.stringify(spec.columns),
        `${tableName}: column set/order mismatch: got [${gotCols.join(", ")}] expected [${spec.columns.join(", ")}]`,
        failures,
      );

      for (const col of cols) {
        assert(
          String(col.type) !== "REAL",
          `${tableName}.${String(col.name)} is REAL — zero REAL columns allowed`,
          failures,
        );
      }

      if (spec.compositePk) {
        const pkCols = cols.filter((c) => Number(c.pk) > 0).map((c) => String(c.name));
        assert(
          JSON.stringify(pkCols) === JSON.stringify(spec.compositePk),
          `${tableName}: composite PK mismatch: got [${pkCols.join(", ")}] expected [${spec.compositePk.join(", ")}]`,
          failures,
        );
      }

      const fks = sqlite.query<Row, []>(`PRAGMA foreign_key_list(\`${tableName}\`)`).all();
      const gotFks = fks
        .map((f) => ({
          from: String(f.from),
          refTable: String(f.table),
          refColumn: String(f.to),
          onDelete: String(f.on_delete).toLowerCase(),
        }))
        .sort((a, b) => a.from.localeCompare(b.from) || a.refTable.localeCompare(b.refTable));
      const wantFks = (spec.fks ?? [])
        .map((f) => ({ ...f }))
        .sort((a, b) => a.from.localeCompare(b.from) || a.refTable.localeCompare(b.refTable));
      assert(
        JSON.stringify(gotFks) === JSON.stringify(wantFks),
        `${tableName}: FK mismatch: got ${JSON.stringify(gotFks)} expected ${JSON.stringify(wantFks)}`,
        failures,
      );

      const idxList = sqlite.query<Row, []>(`PRAGMA index_list(\`${tableName}\`)`).all();
      const gotIndexes: IndexSpec[] = [];
      for (const idx of idxList) {
        const idxName = String(idx.name);
        if (idxName.startsWith("sqlite_autoindex")) continue;
        const info = sqlite.query<Row, []>(`PRAGMA index_info(\`${idxName}\`)`).all();
        const idxSql = sqlite
          .query<{ sql: string | null }, [string]>("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get(idxName);
        gotIndexes.push({
          name: idxName,
          columns: [...info]
            .sort((a, b) => Number(a.seqno) - Number(b.seqno))
            .map((c) => String(c.name)),
          unique: Number(idx.unique) === 1,
          partial: Boolean(idx.partial) || (idxSql?.sql?.includes(" WHERE ") ?? false),
        });
      }
      gotIndexes.sort((a, b) => a.name.localeCompare(b.name));
      const wantIndexes = [...(spec.indexes ?? [])].sort((a, b) => a.name.localeCompare(b.name));
      assert(
        JSON.stringify(gotIndexes) === JSON.stringify(wantIndexes),
        `${tableName}: index mismatch: got ${JSON.stringify(gotIndexes)} expected ${JSON.stringify(wantIndexes)}`,
        failures,
      );
      indexCount += gotIndexes.length;
      partialUniqueCount += gotIndexes.filter((i) => i.unique && i.partial).length;
    }

    const triggers = sqlite
      .query<Row, []>("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all();
    const expectedTriggers = IMMUTABLE_TABLES.flatMap((t) => [
      `${t}_immutable_update`,
      `${t}_immutable_delete`,
    ]).sort();
    const gotTriggers = triggers.map((t) => String(t.name)).sort();
    assert(
      JSON.stringify(gotTriggers) === JSON.stringify(expectedTriggers),
      `trigger set mismatch: got [${gotTriggers.join(", ")}] expected [${expectedTriggers.join(", ")}]`,
      failures,
    );
    for (const trig of triggers) {
      assert(
        IMMUTABLE_TABLES.includes(String(trig.tbl_name)),
        `trigger ${String(trig.name)} is not on a [FACT] table (${String(trig.tbl_name)})`,
        failures,
      );
    }

    const tablesWithCheck = sqlite
      .query<Row, []>("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
      .all()
      .filter((t) => /CHECK\s*\(/i.test(String(t.sql ?? "")))
      .map((t) => String(t.name));
    assert(
      tablesWithCheck.length === 0,
      `CHECK constraints found on: ${tablesWithCheck.join(", ")} — zero CHECK constraints allowed`,
      failures,
    );

    log.info(
      { tables: expectedNames.length, indexes: indexCount, partialUnique: partialUniqueCount, triggers: gotTriggers.length },
      "verify-db ran",
    );
  } finally {
    sqlite.close();
    rmSync(tmpPath, { force: true });
    rmSync(`${tmpPath}-wal`, { force: true });
    rmSync(`${tmpPath}-shm`, { force: true });
  }

  if (failures.length > 0) {
    log.error({ failures: failures.length, first: failures[0], all: failures }, "verify-db FAILED");
    process.exit(1);
  }
  log.info("verify-db PASS");
}

main();
