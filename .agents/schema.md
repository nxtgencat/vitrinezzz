# Vitrine — Database Schema

38 tables total. `scripts/verify-db.ts` asserts exact table/column
order, FKs, and indexes for every table below, `PRAGMA journal_mode = wal`, zero CHECK
constraints anywhere, and immutability triggers on all four `[FACT]` tables.

---

## 1. Global conventions

See `architecture.md` §4.15 for the full list. Restated for reference while reading
this file: `id` TEXT = full `Bun.randomUUIDv7()` · human numbers `<PREFIX>-<7 base32>`
own column · money INTEGER `*Paise` (no REAL anywhere) · `taxRatePct` INTEGER percent ·
quantities INTEGER · timestamps INTEGER unix-ms UTC · booleans INTEGER `is…`/`has…` ·
enums TEXT + Zod union, **zero CHECK constraints** · FKs `<entity>Id`,
`ON DELETE RESTRICT` except the CASCADE list (§8) · tables `snake_case` plural,
columns `snake_case` except the four better-auth tables (exact camelCase, no
remapping).

**Table kinds**: `[REF]` reference/master data · `[DOC]` document header · `[CHILD]`
document line, CASCADE child · `[FACT]` append-only event record, trigger-protected ·
`[SNAP]` derived projection · `[STAGING]` disposable customer state · `[MEDIA]` ·
`[SYS]` · `[AUTH]` better-auth owned.

**FK enforcement**: `PRAGMA foreign_keys = ON` is set at boot on the single shared
connection (`architecture.md` §4.1) — `bun:sqlite` defaults it OFF, so without the
pragma every `ON DELETE RESTRICT`/`CASCADE` below would be decorative. `verify-db`
asserts the pragma reads back `1`.

**Immutability triggers**: `BEFORE UPDATE` and `BEFORE DELETE` raising `ABORT` exist on
every `[FACT]` table (`stock_movements`, `payments`, `order_events`, `audit_events`).
Created once, in the initial migration. Corrections are new rows, never edits.
`verify-db` asserts their existence; `verify-immutability` asserts they fire.

**Projection rule**: `stock_levels` is the only `[SNAP]` table, rebuilt by replay of
`stock_movements`, verified byte-identical by `verify-stock` (`architecture.md` §4.6).

---

## 2. Table inventory

| Kind | Tables | n |
|---|---|---|
| `[REF]` | settings, outlets, roles, staff_profiles, categories, products, variants, batches, customers, cust_addresses, vendors | 11 |
| `[DOC]` | orders, invoices, purchase_bills, stock_transfers, adjustments, returns, shipments | 7 |
| `[CHILD]` | invoice_items, invoice_charges, purchase_bill_items, bill_charges, stock_transfer_items, adjustment_items, return_items | 7 |
| `[FACT]` | stock_movements, payments, order_events, audit_events | 4 |
| `[SNAP]` | stock_levels | 1 |
| `[MEDIA]` | media | 1 |
| `[STAGING]` | cart_items, wishlist_items | 2 |
| `[SYS]` | idempotency_keys | 1 |
| `[AUTH]` | user, session, account, verification | 4 |
| **Total** | | **38** |

---

## 3. Catalog & parties — 7 tables `[REF]`

### 3.1 categories
`id`, `name`, `parentId?` (self FK), `isActive`, `createdAt`, `updatedAt`.
PK `id`; idx `(parentId)`. `parentId` must not create a cycle (service-enforced).

### 3.2 products
`id`, `categoryId`, `name`, `slug`, `hsnCode`, `gstRatePct`, `isActive`, `createdAt`,
`updatedAt`. PK `id`; UNIQUE `(slug)`; idx `(categoryId)`. `slug` server-generated from
name at creation, immutable thereafter; duplicate → `409 duplicate_slug`.

### 3.3 variants
`id`, `productId`, `name`, `sku?`, `barcode?`, `costPricePaise`, `sellingPricePaise`,
`mrpPaise`, `isBase`, `isTaxable`, `isCustomerVisible`, `isActive`, `createdAt`,
`updatedAt`. PK `id`; UNIQUE partial `(sku)` WHERE `sku IS NOT NULL`; UNIQUE partial
`(barcode)` WHERE `barcode IS NOT NULL`; UNIQUE partial `(productId)` WHERE `isBase`;
idx `(productId)`. Creating a product creates its base variant in the same transaction.

### 3.4 batches
`id`, `variantId`, `batchNumber`, `expiryDate?`, `costPricePaise`, `isActive`,
`createdAt`. PK `id`; UNIQUE `(variantId, batchNumber)`. Global per variant, not per
outlet (`architecture.md` §4.6) — no implicit creation path outside the explicit
batch-create route and purchase-bill-issue's create-or-reuse.

### 3.5 customers
`id`, `userId?` (→ `user.id`), `name`, `phone?`, `gstin?`, `isActive`, `createdAt`,
`updatedAt`. PK `id`; UNIQUE partial `(userId)`; UNIQUE partial `(phone)`.
Auto-provisioned on sign-up via better-auth's `user.create.after` hook.

### 3.6 cust_addresses — CASCADE
`id`, `customerId`, `label`, `line1`, `line2?`, `city`, `state`, `pincode`. PK `id`;
idx `(customerId)`; FK CASCADE on customer delete.

### 3.7 vendors
`id`, `name`, `phone`, `gstin?`, `isActive`, `createdAt`, `updatedAt`. PK `id`.

---

## 4. Inventory & stock — 6 tables

### 4.1 stock_levels `[SNAP]`
`variantId`, `outletId`, `batchId`, `quantity`, `lastMovementId`, `updatedAt`.
Composite PK `(variantId, outletId, batchId)`. Cache of
`SUM(stock_movements.delta)` per key — display reads only, **never** a decision gate
(`architecture.md` §4.6). `lastMovementId` is a denormalized pointer into
`stock_movements` — **no FK**, exactly like `stock_movements.sourceId` (§4.2); a
projection must never constrain or be constrained by the fact table it derives from.

### 4.2 stock_movements `[FACT]`
`id`, `variantId`, `outletId`, `batchId`, `delta` (signed), `reason`
(`initial|purchase|sale|return_in|return_out|transfer_out|transfer_in|adjustment_in|
adjustment_out`), `sourceType`, `sourceId?`, `createdAt`. PK `id`; idx
`(variantId, outletId)`; idx `(sourceType, sourceId)`; trigger-protected.
`(sourceType, sourceId)` must be a valid pair for `reason` (XOR rule, §7).

### 4.3 stock_transfers `[DOC]`
`id`, `transferNumber`, `fromOutletId`, `toOutletId`, `status`
(`draft|confirmed|void`), `version`, `createdAt`, `updatedAt`. PK `id`; UNIQUE
`(transferNumber)`. `fromOutletId ≠ toOutletId` (service-enforced).

### 4.4 stock_transfer_items `[CHILD]` — CASCADE
`id`, `stockTransferId`, `variantId`, `batchId`, `quantity`. PK `id`; idx
`(stockTransferId)`.

### 4.5 adjustments `[DOC]`
`id`, `adjustmentNumber`, `outletId`, `reason`, `status` (`draft|confirmed|void`),
`version`, `createdAt`, `updatedAt`. PK `id`; UNIQUE `(adjustmentNumber)`.

### 4.6 adjustment_items `[CHILD]` — CASCADE
`id`, `adjustmentId`, `variantId`, `batchId`, `quantity` (signed), `unitValuePaise`.
PK `id`; idx `(adjustmentId)`.

---

## 5. Purchasing — 3 tables

### 5.1 purchase_bills `[DOC]`
`id`, `billNumber`, `vendorId`, `outletId`, `status` (`draft|issued|void`),
`subtotalPaise`, `taxPaise`, `totalPaise`, `version`, `createdAt`, `updatedAt`. PK
`id`; UNIQUE `(billNumber)`.

### 5.2 purchase_bill_items `[CHILD]` — CASCADE
`id`, `purchaseBillId`, `variantId`, `batchId?`, `batchNumber?` (draft intent —
create-or-reuse at issue), `quantity`, `unitCostPaise`, `taxRatePct`,
`taxAmountPaise`, `lineTotalPaise`. PK `id`; idx `(purchaseBillId)`.

### 5.3 bill_charges `[CHILD]` — CASCADE
`id`, `purchaseBillId`, `name`, `amountPaise` (signed). PK `id`; idx
`(purchaseBillId)`.

---

## 6. Orders & sales documents — 7 tables

### 6.1 orders `[DOC]`
`id`, `orderNumber`, `orderType` (`pos|manual|storefront`), `customerId?`,
`outletId`, `status` (`draft|pending|confirmed|cancelled`), `totalPaise`, `version`,
`createdAt`, `updatedAt`. PK `id`; UNIQUE `(orderNumber)`.

### 6.2 invoices `[DOC]`
`id`, `invoiceNumber`, `orderId?`, `customerId?`, `outletId`, `status`
(`draft|issued|void`), `subtotalPaise`, `taxPaise`, `totalPaise`, `pdfPath?`,
`supersedesId?` (self FK), `version`, `createdAt`, `updatedAt`. PK `id`; UNIQUE
`(invoiceNumber)`.

### 6.3 invoice_items `[CHILD]` — CASCADE
`id`, `invoiceId`, `variantId?`, `name` (snapshot), `quantity`, `unitPricePaise`,
`taxRatePct`, `taxAmountPaise`, `lineTotalPaise`, `isCustomItem`, `allocations`
(JSON — `[{batchId, qty}]`). PK `id`; idx `(invoiceId)`. `isCustomItem = 1` ⇒
`variantId IS NULL`; `isCustomItem = 0` ⇒ `variantId NOT NULL` (XOR rule, §7).

### 6.4 invoice_charges `[CHILD]` — CASCADE
`id`, `invoiceId`, `name`, `amountPaise` (signed). PK `id`; idx `(invoiceId)`.

### 6.5 returns `[DOC]`
`id`, `returnNumber`, `returnType` (`sales|purchase`), `orderId?`,
`purchaseBillId?`, `outletId`, `status` (`draft|confirmed|void`), `version`,
`createdAt`, `updatedAt`. PK `id`; UNIQUE `(returnNumber)`. Exactly one of `orderId` /
`purchaseBillId` set, matching `returnType` (XOR rule, §7).

### 6.6 return_items `[CHILD]` — CASCADE
`id`, `returnId`, `variantId`, `originalItemId` (polymorphic:
`invoice_items.id` for sales, `purchase_bill_items.id` for purchase, discriminated by
the header's `returnType`), `quantity`, `unitPricePaise`, `taxAmountPaise` (both
copied from the original line at confirm). PK `id`; idx `(returnId)`. `quantity` ≤
returnable, computed in-tx, never stored.

### 6.7 shipments `[DOC]`
`id`, `shipmentNumber`, `invoiceId`, `carrier`, `awbNumber?`, `status`
(`created|dispatched|delivered`), `version`, `createdAt`, `updatedAt`. PK `id`;
UNIQUE `(shipmentNumber)`; idx `(invoiceId)`. Whole-invoice, no line quantities; one
invoice may have many shipments.

---

## 7. Payments — 1 table `[FACT]`

### 7.1 payments
`id`, `paymentNumber`, `direction` (`in|out`), `partyType` (`customer|vendor`),
`partyId`, `invoiceId?`, `purchaseBillId?`, `returnId?`, `outletId`, `amountPaise`,
`mode` (`cash|upi|card|bank|gateway`), `gateway?`, `gatewayPaymentId?`,
`gatewayEventId?`, `status` (`pending|confirmed`), `createdAt`. PK `id`; UNIQUE
`(paymentNumber)`; UNIQUE partial `(gateway, gatewayEventId)` WHERE
`gateway IS NOT NULL`; idx `(partyType, partyId)`; idx `(invoiceId)`; idx
`(purchaseBillId)`; trigger-protected.

One table, `direction` column, covers money received, money paid out, and refunds in
both directions — a refund against an invoice is an `out` row against that invoice; a
refund a vendor owes back is an `in` row against that bill. Balance for any document is
`Σ in − Σ out` over its linked rows, one query, no join. Exactly one of `invoiceId` /
`purchaseBillId` / `returnId` set per row, matching context (XOR rule, §7). The
webhook dedupe key is `UNIQUE(gateway, gatewayEventId)`.

---

## 8. Org, RBAC & staff — 4 tables `[REF]`

### 8.1 settings — singleton, `id = 'singleton'`
`id`, `orgName`, `gstin?`, `fiscalYearStartMonth`, `currency` (default `INR`),
`timezone` (default `Asia/Kolkata`), `defaultOutletId?`, `createdAt`, `updatedAt`. PK
`id`, exactly one row.

### 8.2 outlets
`id`, `name`, `isActive`, `createdAt`, `updatedAt`. PK `id`. No secondary indexes.

### 8.3 roles
`id`, `name`, `capabilities` (JSON array, closed 9-capability set), `scope`
(`global|outlet`), `outletId?` (required iff `scope = 'outlet'`, service-enforced),
`createdAt`, `updatedAt`. PK `id`; UNIQUE `(name)`; idx `(scope)`.

### 8.4 staff_profiles
`id`, `userId` (→ `user.id`), `outletId`, `roleId`, `phone?`, `isActive`,
`isProtected`, `createdAt`, `updatedAt`. PK `id`; UNIQUE `(userId)`. An outlet-scoped
role requires the profile's `outletId` to equal the role's `outletId`
(service-enforced).

---

## 9. Order & audit facts — 2 tables `[FACT]`

### 9.1 order_events
`id`, `orderId`, `type` (e.g. `order.confirmed`, `invoice.issued`,
`payment.confirmed`, `return.confirmed`, `shipment.dispatched`), `payload` (JSON),
`actorId?`, `actorType` (`staff|customer|system|webhook`), `createdAt`. PK `id`; idx
`(orderId, createdAt)`; trigger-protected. Written by every order/invoice/
shipment/payment state transition tied to a specific order, same transaction as the
transition.

### 9.2 audit_events
`id`, `entityType` (`category|product|variant|batch|outlet|role|staff|settings|
media`), `entityId`, `action` (`created|updated|deactivated|deleted`), `actorId`,
`actorType` (`staff|system`), `before` (JSON, nullable), `after` (JSON), `createdAt`.
PK `id`; idx `(entityType, entityId)`; idx `(actorId)`; trigger-protected. Written by
every mutating write to catalog, RBAC, settings, outlets, or media, same transaction
as the write. Rationale for keeping this separate from `order_events`:
`architecture.md` §4.12.

---

## 10. Media — 1 table `[MEDIA]`

### 10.1 media
`id`, `ownerType` (`product|variant`), `ownerId`, `path`, `thumbPath?`, `mimeType`,
`sizeBytes`, `altText?`, `createdAt`. PK `id`; idx `(ownerType, ownerId)`. No
versioning, no albums — one file, one thumbnail, one row per upload.

---

## 11. Cart & wishlist — 2 tables `[STAGING]`

### 11.1 cart_items
`id`, `customerId`, `variantId`, `quantity`, `createdAt`, `updatedAt`. PK `id`;
UNIQUE `(customerId, variantId)`.

### 11.2 wishlist_items
`id`, `customerId`, `variantId`, `createdAt`. PK `id`; UNIQUE
`(customerId, variantId)`.

Neither table produces a fact-table row on write. See `architecture.md` §4.11 for the
checkout re-derivation rule that keeps this safe.

---

## 12. System — 1 table `[SYS]`

### 12.1 idempotency_keys
`id`, `operation` (`METHOD /api/<pattern>`), `key` (client `Idempotency-Key`),
`requestHash` (sha256 of canonicalized body + actor id), `responseSnapshot` (JSON,
replayed verbatim), `status` (always `'completed'` — inserted in the same tx as the
work), `createdAt`, `expiresAt` (reaped 24h after `createdAt`). PK `id`; UNIQUE
`(operation, key)`; idx `(expiresAt)`.

---

## 13. Auth — 4 tables `[AUTH]`

Owned by better-auth, defined in `db/schema/auth.ts` purely so `drizzle-kit` can
manage their migrations alongside everything else. Column names are better-auth's
exact documented names (camelCase), zero remapping. All ids TEXT; timestamps INTEGER
ms; `emailVerified` INTEGER boolean.

- **user** — `id` PK, `name` NOT NULL, `email` NOT NULL UNIQUE, `emailVerified` NOT
  NULL, `image?`, `createdAt`, `updatedAt`.
- **session** — `id` PK, `userId` NOT NULL FK user CASCADE, `token` NOT NULL UNIQUE,
  `expiresAt` NOT NULL, `ipAddress?`, `userAgent?`, `createdAt`, `updatedAt`. Idx
  `(userId)`.
- **account** — `id` PK, `userId` NOT NULL FK user CASCADE, `accountId` NOT NULL,
  `providerId` NOT NULL, `accessToken?`, `refreshToken?`,
  `accessTokenExpiresAt?`, `refreshTokenExpiresAt?`, `scope?`, `idToken?`,
  `password?`, `createdAt`, `updatedAt`. Idx `(userId)`; UNIQUE
  `(providerId, accountId)`.
- **verification** — `id` PK, `identifier` NOT NULL, `value` NOT NULL, `expiresAt`
  NOT NULL, `createdAt`, `updatedAt`.

`session.userId` and `account.userId` are `ON DELETE CASCADE` (better-auth documented
mapping).

---

## 14. XOR / exactly-one rules (all service-layer, never DB — zero CHECK constraints)

1. `returns`: exactly one of `orderId` / `purchaseBillId`, matching `returnType`
   (`sales` → order; `purchase` → bill).
2. `payments`: exactly one of `invoiceId` / `purchaseBillId` / `returnId`, matching
   `(direction, partyType)`; `mode = 'gateway'` requires `gateway` + `gatewayEventId`.
3. `stock_movements`: `(sourceType, sourceId)` must be a valid pair for `reason`
   (`sale`→invoice id, `purchase`→bill id, `transfer_in/out`→transfer id,
   `adjustment_in/out`→adjustment id, `return_in`→sales return id,
   `return_out`→purchase return id, `initial`→null).
4. `staff_profiles`: `scope = 'outlet'` roles require the profile's `outletId` to
   equal the role's `outletId`.
5. `stock_transfers`: `fromOutletId ≠ toOutletId`.
6. `invoice_items`: `isCustomItem = 1` ⇒ `variantId IS NULL`; `isCustomItem = 0` ⇒
   `variantId NOT NULL`.

## 15. CASCADE list (complete — nothing else cascades)

`cust_addresses`, `invoice_items`, `invoice_charges`, `purchase_bill_items`,
`bill_charges`, `stock_transfer_items`, `adjustment_items`, `return_items` (parent
delete) — plus better-auth's `session` and `account` (cascade on `user`). Everything
else is `ON DELETE RESTRICT`. In practice nothing outside this list is ever deleted:
`[FACT]` rows are trigger-blocked, documents `void`, references deactivate.

## 16. Index summary

- 38 PKs + 1 composite PK (`stock_levels`).
- UNIQUEs: 8 document numbers (`OR/INV/BL/TR/AJ/RT/SH/PY`), `roles.name`,
  `products.slug`, `variants.sku` (partial), `variants.barcode` (partial),
  `variants(productId)` WHERE `isBase` (partial), `batches(variantId, batchNumber)`,
  `customers.userId` (partial), `customers.phone` (partial), `staff_profiles.userId`,
  `idempotency_keys(operation, key)`, `payments(gateway, gatewayEventId)` (partial),
  `cart_items(customerId, variantId)`, `wishlist_items(customerId, variantId)`,
  `user.email`, `session.token`, `account(providerId, accountId)`.
- Secondary indexes: as listed per table above (~26).
- **0 CHECK constraints** (banned, `verify-db` asserts this). **0 triggers except the
  4 immutability triggers** (§1).

## 17. Invariants (mirrored in `audit.md` §1)

| # | Invariant | Checked by |
|---|---|---|
| I1 | `stock_levels.quantity = SUM(stock_movements.delta)` per `(variantId, outletId, batchId)`; never negative post-commit. | `verify-stock` |
| I2 | Every money column is INTEGER `*Paise`; no REAL column anywhere; `total ≥ 0` enforced at document issue. | `verify-db` + `verify-hygiene` |
| I3 | `[FACT]` rows (`stock_movements`, `payments`, `order_events`, `audit_events`) are insert-only — DB-trigger-enforced. | `verify-db` (triggers exist) + `verify-immutability` (fire) |
| I4 | An issued document's totals are computed once, from stored line/charge snapshots, and never re-read from a client-supplied total field. | scenario tests + client-origin scan |
| I5 | Same idempotency key + same request hash replays the stored response with zero side effects; same key + different hash → `409`. | scenario tests |
| I6 | An issued/confirmed document is never edited or returned to draft; corrections are new documents or new fact rows. | scenario tests |
| I7 | A capability check is asserted inside the service function, not only at the route — direct calls, cron, and webhooks cannot bypass it. | RBAC matrix tests |
| I8 | Every order-linked state transition writes exactly one `order_events` row, same transaction. | scenario tests |
| I9 | At most one `payments` row exists per `(gateway, gatewayEventId)`. | scenario tests |
| I10 | Every mutating write to an audited domain (§9.2) writes exactly one `audit_events` row, same transaction. | `verify-audit` |
| I11 | Cart/wishlist rows never generate a fact-table event; checkout re-derives price, tax, and stock for every line regardless of cart contents. | scenario test |
