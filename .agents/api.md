# Vitrine — API

Hono server, `hc<AppType>()` typed client. Base path `/api`, JSON
in/out, `camelCase`. Every row here **must exist as a mounted route** and every
mounted route **must appear in a row** — `scripts/verify-routes.ts` checks both
directions, wired into `bun run ci` (`audit.md` §2).

---

## 0. Conventions (learn once, used everywhere)

**Guards**: `*` public · `A` better-auth route, mounted verbatim · `S` staff session
(`requireStaff`) · `C` customer session (`requireCustomer`) · `R(cap)` = staff +
capability, asserted in middleware **and** again at the top of the service function
(`architecture.md` §4.14). Wrong guard type or missing session → `401`; authenticated
but lacking the capability/scope → `403`.

**Idempotency**: `I` = mutating route, requires `Idempotency-Key`, runs through
`withIdempotency` (`architecture.md` §4.2). Missing → `400 VALIDATION`, `reason:
idempotency_key_required`. Reads never require it. Exceptions: `/api/auth/*`
(better-auth's own flow) and `/api/webhooks/*` (signature + dedupe instead, §7).

**Realtime**: `‡` marks a route that publishes a topic after commit
(`architecture.md` §4.8) — payload `{ type, entityId, at }`; clients refetch that
entity.

**Error envelope, lists, filters, money-on-the-wire**: see `architecture.md` §4.13 —
not restated per route below.

---

## 1. Auth — `A` (better-auth, mounted verbatim, no idempotency)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/sign-up/email` | Triggers `user.create.after` → auto-provisions a `customers` row. |
| POST | `/api/auth/sign-in/email` | |
| POST | `/api/auth/sign-out` | |
| GET | `/api/auth/session` | |

Staff accounts are created via §2 (`POST /api/staff`), never via self-service sign-up.

## 2. Org, staff & RBAC

| Method | Path | Guard | Idem | Notes |
|---|---|---|---|---|
| GET | `/api/settings` | S | – | Singleton settings row. |
| PUT | `/api/settings` | R(canManageStaff) | I | `{ orgName?, gstin?, currency?, timezone?, fiscalYearStartMonth?, defaultOutletId? }`; `defaultOutletId` must be an active outlet. |
| GET | `/api/outlets` | S | – | Filter `active`. |
| POST | `/api/outlets` | R(canManageStaff) | I | `{ name }`. |
| PUT | `/api/outlets/:id` | R(canManageStaff) | I | `{ name?, isActive? }`; deactivating `settings.defaultOutletId` → `409 invalid_transition`. |
| GET | `/api/roles` | S | – | Filter `scope`. |
| POST | `/api/roles` | R(canManageStaff) | I | `{ name, capabilities[], scope, outletId? }`; capability set validated against the closed 9; `scope:'outlet'` requires `outletId`; duplicate `name` → `409`. |
| PUT | `/api/roles/:id` | R(canManageStaff) | I | Same shape. |
| GET | `/api/staff` | S | – | Filters `outletId`, `roleId`, `active`. |
| POST | `/api/staff` | R(canManageStaff) | I | `{ email, password, name, outletId, roleId, phone? }` — creates the auth user + profile in one transaction; duplicate email → `409`. |
| PUT | `/api/staff/:id` | R(canManageStaff) | I | `{ outletId?, roleId?, phone?, isActive? }`. |
| POST | `/api/staff/:id/deactivate` | R(canManageStaff) | I | `isProtected` row → `409 protected_resource`. |

Bootstrap admin: created at first boot from `SUPERUSER_EMAIL`/`SUPERUSER_PASSWORD`
with an auto-seeded `Admin` role (all 9 capabilities); `isProtected = true`.

## 3. Catalog

| Method | Path | Guard | Idem | Notes |
|---|---|---|---|---|
| GET | `/api/categories` | * | – | Flat list; tree assembly is client-side. Filter `active`. |
| POST | `/api/categories` | R(canManageCatalog) | I | `{ name, parentId? }`; `parentId` must not create a cycle. |
| PUT | `/api/categories/:id` | R(canManageCatalog) | I | `{ name?, parentId?, isActive? }`. |
| GET | `/api/products` | * | – | Filters `q` (name), `categoryId`, `active`. |
| GET | `/api/products/:slug` | * | – | Product detail + media + variants. |
| POST | `/api/products` | R(canManageCatalog) | I | `{ categoryId?, name, hsnCode?, gstRatePct?, baseVariant: { name, sku?, barcode?, costPricePaise, sellingPricePaise, mrpPaise? } }` — creates product + base variant in one tx; `slug` server-generated, unique; duplicate → `409 duplicate_slug`. |
| PUT | `/api/products/:id` | R(canManageCatalog) | I | `{ categoryId?, name?, hsnCode?, gstRatePct? }`; `slug` not editable. |
| POST | `/api/products/:id/deactivate` | R(canManageCatalog) | I | |
| GET | `/api/variants` | * | – | Filters `productId`, `q` (name/sku), `outletId` (joins per-outlet stock), `active`. |
| POST | `/api/variants` | R(canManageCatalog) | I | Duplicate `sku`/`barcode` → `409 duplicate_sku`. |
| PUT | `/api/variants/:id` | R(canManageCatalog) | I | |
| GET/POST | `/api/products/:id/media` , `/api/variants/:id/media` | * / R(canManageCatalog) | I on POST | Multipart upload; validates MIME (`jpeg/png/webp`) + size (≤8MB); generates WebP thumbnail; writes `media` + `audit_events` in one tx. |
| DELETE | `/api/media/:id` | R(canManageCatalog) | I | Hard delete; writes `audit_events`. |

## 4. Inventory

| Method | Path | Guard | Idem | Notes |
|---|---|---|---|---|
| POST | `/api/inventory/batches` | R(canManageInventory) | I | The only batch entry point outside purchase-bill-issue's create-or-reuse. `UNIQUE(variantId, batchNumber)` violation → `409 duplicate_batch`. |
| GET | `/api/inventory/stock-levels` | S | – | Filters `outletId`, `variantId`, low-stock threshold. Display read — never a decision source. |
| GET/POST | `/api/inventory/transfers[/:id]` | R(canManageInventory) | I on POST | `fromOutletId ≠ toOutletId` enforced. |
| PUT | `/api/inventory/transfers/:id` | R(canManageInventory) | I | Draft only; versioned — `409 stale_version` on conflict. |
| POST | `/api/inventory/transfers/:id/confirm` ‡ | R(canManageInventory) | I | Atomic — one insufficient line rolls back the whole document, `409 insufficient_stock`, zero movements written. Writes paired `transfer_out`/`transfer_in`. |
| POST | `/api/inventory/transfers/:id/void` | R(canManageInventory) | I | Draft only. |
| GET/POST | `/api/inventory/adjustments[/:id]` | R(canManageInventory) | I on POST | |
| POST | `/api/inventory/adjustments/:id/confirm` ‡ | R(canManageInventory) | I | Writes signed `adjustment_in`/`adjustment_out` per line against explicit batches. |
| POST | `/api/inventory/adjustments/:id/void` | R(canManageInventory) | I | Draft only. |

## 5. Purchasing

| Method | Path | Guard | Idem | Notes |
|---|---|---|---|---|
| GET | `/api/vendors` | S | – | |
| POST | `/api/vendors` | R(canManagePurchases) | I | `{ name, phone, gstin? }`. |
| GET/POST | `/api/purchase-bills[/:id]` | R(canManagePurchases) | I on POST | Draft CRUD, items + signed charges. |
| PUT | `/api/purchase-bills/:id` | R(canManagePurchases) | I | Draft only; versioned. |
| POST | `/api/purchase-bills/:id/issue` ‡ | R(canManagePurchases) | I | Recomputes money (floor-tax rule), creates-or-reuses batches by `(variantId, batchNumber)`, writes `purchase` in-movements per line, snapshots totals. Re-issue → `409 already_issued`, zero rows. |
| POST | `/api/purchase-bills/:id/void` | R(canManagePurchases) | I | Draft only — never reverses stock. |

## 6. Sales

| Method | Path | Guard | Idem | Notes |
|---|---|---|---|---|
| GET/POST | `/api/orders[/:id]` | R(canManageSales) | I on POST | `orderType` = `pos`\|`manual`. |
| PUT | `/api/orders/:id` | R(canManageSales) | I | Draft only. |
| POST | `/api/orders/:id/confirm` ‡ | R(canManageSales) | I | `draft → confirmed`; creates the draft invoice. Plays no stock. |
| POST | `/api/orders/:id/cancel` ‡ | R(canManageSales) | I | |
| GET | `/api/invoices[/:id]` | S | – | Detail includes computed outstanding balance. |
| PUT | `/api/invoices/:id` | S | I | Draft only; versioned. |
| POST | `/api/invoices/:id/issue` ‡ | R(canManageSales) | I | **The shared `issueInvoice` core** — recomputes totals from snapshots + charges, allocates batches FIFO, writes `sale` movements per line/batch, snapshots totals, marks `issued`. Re-issue → `409 already_issued`, zero rows; insufficient stock → `409`, whole document rolls back. |
| POST | `/api/invoices/:id/void` | R(canManageSales) | I | Draft only. |
| POST | `/api/invoices/:id/render-pdf` | R(canManageSales) | – | Body `{ html }` (≤256KB) — client-built markup, server only prints (`architecture.md` §4.9). Non-fatal: failure → warning + null `pdfPath`, invoice stands. |
| POST | `/api/sales/pos/checkout` ‡ | R(canManageSales) | I | POS one-step sale: create + issue immediately in one transaction, via the same `issueInvoice` core. |

## 7. Payments

| Method | Path | Guard | Idem | Notes |
|---|---|---|---|---|
| GET | `/api/payments` | R(canManagePayments) | – | Filters `direction`, `partyType`/`partyId`, date range. |
| POST | `/api/payments` | R(canManagePayments) | I | `{ direction, partyType, partyId, invoiceId? \| purchaseBillId? \| returnId?, amountPaise, mode, outletId }`. Received/made capped at outstanding balance (`409 over_payment`); refund capped at paid balance (`409 over_return` scope reused where applicable). |
| POST | `/api/webhooks/payments/:gateway` | * (signature-verified) | – | No idempotency header — see `architecture.md` §4.2. HMAC verified before any DB access; dedupe on `payments UNIQUE(gateway, gatewayEventId)`; replay → `200`, zero side effects. Success path: mark payment `confirmed` → run the pending order's confirm+issue path (final stock gate re-runs; short stock triggers the auto-cancel+refund compensation, `architecture.md` §4.7). |

## 8. Returns & fulfillment

| Method | Path | Guard | Idem | Notes |
|---|---|---|---|---|
| GET/POST | `/api/returns[/:id]` | R(canManageReturns) | I on POST | `returnType` = `sales`\|`purchase`; exactly one of `orderId`/`purchaseBillId` (XOR). |
| PUT | `/api/returns/:id` | R(canManageReturns) | I | Draft only. |
| POST | `/api/returns/:id/confirm` ‡ | R(canManageReturns) | I | Caps recomputed in-tx (`409 over_return`); sales restock mirrors the original allocations, purchase de-stocks the bill's batch; values snapshotted from the original line. |
| POST | `/api/returns/:id/void` | R(canManageReturns) | I | Draft only. |
| GET/POST | `/api/shipments[/:id]` | R(canManageFulfillment) | I on POST | Whole-invoice, no line quantities. |
| PUT | `/api/shipments/:id` | R(canManageFulfillment) | I | Carrier/AWB, while `created` only; versioned. |
| POST | `/api/shipments/:id/dispatch` ‡ | R(canManageFulfillment) | I | |
| POST | `/api/shipments/:id/deliver` ‡ | R(canManageFulfillment) | I | |

## 9. Storefront (customer-facing)

| Method | Path | Guard | Idem | Notes |
|---|---|---|---|---|
| GET | `/api/storefront/products` | * | – | `isCustomerVisible` variants only; stock exposed only as `isInStock` — **never quantity**. |
| GET | `/api/storefront/products/:slug` | * | – | Product detail. |
| GET | `/api/storefront/cart` | C | – | Current cart, cross-device (keyed by `customerId`). |
| PUT | `/api/storefront/cart` | C | I | Upsert `{ variantId, quantity }`. |
| DELETE | `/api/storefront/cart/:variantId` | C | I | |
| GET/POST/DELETE | `/api/storefront/wishlist[/:variantId]` | C | I on POST/DELETE | |
| GET/POST | `/api/storefront/addresses[/:id]` | C | I on POST | Own rows only. |
| POST | `/api/storefront/checkout` ‡ | C | I (rate-limited 5/min) | Body `{ custAddressId, paymentMode }` **only — no prices, no cart snapshot**. Re-reads the cart, re-prices every line from `variants`, re-derives stock in-tx (`architecture.md` §4.11). `cod` issues the invoice immediately; `gateway` defers to the webhook after a stock pre-gate. On any gate failure, the whole transaction rolls back and the cart is untouched. |
| GET | `/api/storefront/orders[/:id]` | C | – | Own orders only (404 on others'); detail includes `order_events` timeline. |
| POST | `/api/storefront/orders/:id/cancel` ‡ | C | I | `pending` only. |
| POST | `/api/storefront/returns` | C | I | Draft sales return on own issued invoice; confirmation is staff-side (§8). |

The client never treats a gateway redirect as success — it polls/subscribes to
`order:{id}` until status leaves `awaiting_payment`.

## 10. Realtime & ops

| Method | Path | Guard | Notes |
|---|---|---|---|
| WS | `/api/ws` | S \| C | Upgrade requires a valid session. Subscribe frame: `{ op: "subscribe", topics: [...] }`. Topics: `order:{id}`, `invoice:{id}`, `stock:{outletId}` — authorized per topic (`architecture.md` §4.8). |
| GET | `/api/health` | * | Never `500` for a reportable DB condition — a degraded-but-queryable DB reports `{ status: "degraded" }` at `200`, so uptime monitors alert on body content. Returns `{ status, dbTimeMs, ledgerCounts }`. |
| GET | `/api/audit` | R(canManageStaff) | Reads `audit_events`. Filters `entityType`, `entityId`, `actorId`, date range. |

---

## 11. Route inventory summary (for `verify-routes`)

~80 routes across 10 domain sections above plus better-auth's mounted paths. The
checker reads every row in §1–§10 and every route mounted on `app.routes`, and asserts
the two sets are equal in both directions — nothing documented-but-unimplemented,
nothing implemented-but-undocumented.
