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

**Path-cell shorthand** (how `verify-routes` expands rows): a path cell may carry
comma-separated paths; a trailing `‡` is the realtime marker (ignored by the
verifier); `[/:param]` expands by method — GET → base + `/:param` (list + detail),
POST → base only (create), DELETE → `/:param` only (delete one). The §1 auth rows
collapse onto the single mounted wildcard pair `GET/POST /api/auth/*`; `WS` rows
map to the GET upgrade.

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
| GET | `/api/settings` | S | – | Singleton settings row; `404` when never written (the singleton is upserted by the first `PUT`, not seeded at boot). |
| PUT | `/api/settings` | R(canManageStaff) | I | `{ orgName?, gstin?, currency?, timezone?, fiscalYearStartMonth?, defaultOutletId? }` — upserts the singleton; the first write requires `orgName` + `fiscalYearStartMonth` (else `400`), `currency`/`timezone` default `INR`/`Asia/Kolkata`. `defaultOutletId` must be an active outlet (`404` missing, `409 invalid_transition` inactive); `null` clears it. |
| GET | `/api/outlets` | S | – | Filter `active`. |
| POST | `/api/outlets` | R(canManageStaff) | I | `{ name }`. |
| PUT | `/api/outlets/:id` | R(canManageStaff) | I | `{ name?, isActive? }`; deactivating `settings.defaultOutletId` → `409 invalid_transition`. |
| GET | `/api/roles` | S | – | Filter `scope`. |
| POST | `/api/roles` | R(canManageStaff) | I | `{ name, capabilities[], scope, outletId? }`; capability set validated against the closed 9; `scope:'outlet'` requires `outletId`; duplicate `name` → `409`. |
| PUT | `/api/roles/:id` | R(canManageStaff) | I | Same shape; duplicate `name` (self-excluding) → `409 duplicate_role`. No role is protected — the `Admin` role is editable like any other (the bootstrap profile is what `isProtected` guards). |
| GET | `/api/staff` | S | – | Filters `outletId`, `roleId`, `active`; rows join the auth user's `name`/`email`. |
| POST | `/api/staff` | R(canManageStaff) | I | `{ email, password, name, outletId, roleId, phone? }` — creates the auth user (better-auth's own transaction, outside the idempotency tx) then the profile + audit row in the idempotency transaction; duplicate email → `409 duplicate_email`. An outlet-scoped role requires `outletId` = the role's outlet (`400 outlet mismatch`). |
| PUT | `/api/staff/:id` | R(canManageStaff) | I | `{ outletId?, roleId?, phone?, isActive? }`; `isActive: 0` on an `isProtected` profile → `409 protected_resource`. Self-downgrade (an actor editing their own profile) is allowed. |
| POST | `/api/staff/:id/deactivate` | R(canManageStaff) | I | `isProtected` row → `409 protected_resource`. |

Bootstrap admin: created at first boot from `SUPERUSER_EMAIL`/`SUPERUSER_PASSWORD`
with an auto-seeded `Admin` role (all 9 capabilities); `isProtected = true`.

## 3. Catalog

| Method | Path | Guard | Idem | Notes |
|---|---|---|---|---|
| GET | `/api/categories` | * | – | Flat list; tree assembly is client-side. Filter `active`. |
| POST | `/api/categories` | R(canManageCatalog) | I | `{ name, parentId? }`; `parentId` must exist (else `404`); a parent chain that would cycle back to the category → `409 category_cycle`. |
| PUT | `/api/categories/:id` | R(canManageCatalog) | I | `{ name?, parentId?, isActive? }`; same `409 category_cycle` guard. |
| GET | `/api/products` | * | – | Filters `q` (name), `categoryId`, `active`. |
| GET | `/api/products/:slug` | * | – | Product detail + media + variants. |
| POST | `/api/products` | R(canManageCatalog) | I | `{ categoryId?, name, hsnCode?, gstRatePct?, baseVariant: { name, sku?, barcode?, costPricePaise, sellingPricePaise, mrpPaise? } }` — creates product + base variant in one tx; `slug` server-generated, unique; duplicate → `409 duplicate_slug`. |
| PUT | `/api/products/:id` | R(canManageCatalog) | I | `{ categoryId?, name?, hsnCode?, gstRatePct? }`; `slug` not editable. |
| POST | `/api/products/:id/deactivate` | R(canManageCatalog) | I | |
| GET | `/api/variants` | * | – | Filters `productId`, `q` (name/sku), `outletId` (joins per-outlet stock), `active`. |
| POST | `/api/variants` | R(canManageCatalog) | I | Duplicate `sku`/`barcode` → `409 duplicate_sku`. |
| PUT | `/api/variants/:id` | R(canManageCatalog) | I | |
| GET | `/api/products/:id/media` | * | – | List (deterministic `createdAt`, `id` order). Media survive owner deactivation — no cascade delete. |
| GET | `/api/variants/:id/media` | * | – | List (deterministic order). |
| GET | `/api/media/:id` | * | – | Serves the original bytes with `content-type: mimeType` — the only way to fetch stored media bytes. `404` when the row or the underlying storage file is gone. |
| POST | `/api/products/:id/media` , `/api/variants/:id/media` | R(canManageCatalog) | I | Multipart `{ file, altText? }`. Effective MIME comes from the filename extension (`jpg`/`jpeg`/`png`/`webp`, `architecture.md` §4.10); size ≤8MB; WebP thumbnail generated; corrupt-but-valid-MIME bytes → `400 image decode failed`. The idempotency hash binds the file's sha256 — same key with different bytes → `409 idempotency_mismatch`. Storage files are written before the tx and removed on replay/rollback. Writes `media` + `audit_events` in one tx. |
| DELETE | `/api/media/:id` | R(canManageCatalog) | I | Hard delete; removes the stored original + thumbnail files after the tx; writes `audit_events`. |

## 4. Inventory

| Method | Path | Guard | Idem | Notes |
|---|---|---|---|---|
| POST | `/api/inventory/batches` | R(canManageInventory) | I | The only batch entry point outside purchase-bill-issue's create-or-reuse. `UNIQUE(variantId, batchNumber)` violation → `409 duplicate_batch`. |
| GET | `/api/inventory/stock-levels` | S | – | Filters `outletId`, `variantId`, low-stock threshold. Display read — never a decision source. |
| GET | `/api/inventory/transfers` | R(canManageInventory) | – | List; filter `status` (`draft\|confirmed\|void`), paginated. |
| GET | `/api/inventory/transfers/:id` | S | – | Header + items. |
| POST | `/api/inventory/transfers` | R(canManageInventory) | I | `{ fromOutletId, toOutletId, items: [{ variantId, batchId, quantity ≥ 1 }] }`; `fromOutletId ≠ toOutletId` else `400 same outlet`. A transfer spans two outlets, so **no outlet scope applies** — an outlet-scoped role is denied (`403`). |
| PUT | `/api/inventory/transfers/:id` | R(canManageInventory) | I | Full-replace of a draft: create body + `version`; `409 stale_version` on conflict, `409 invalid_transition` on confirmed/voided. |
| POST | `/api/inventory/transfers/:id/confirm` ‡ | R(canManageInventory) | I | Draft-only. One insufficient line rolls back the whole document — `409 insufficient_stock`, zero movements written. Writes paired `transfer_out`/`transfer_in` (`sourceType=transfer`). Re-confirm → `409 invalid_transition`, zero movements. |
| POST | `/api/inventory/transfers/:id/void` | R(canManageInventory) | I | Draft only. |
| GET | `/api/inventory/adjustments` | R(canManageInventory) | – | List; filter `status`, paginated. Scoped to the acting outlet. |
| GET | `/api/inventory/adjustments/:id` | S | – | Header + items. |
| POST | `/api/inventory/adjustments` | R(canManageInventory) | I | `{ outletId, reason, items: [{ variantId, batchId, quantity ≠ 0 }] }` — signed quantity (`+` in, `-` out). `unitValuePaise` is server-derived from the batch's `costPricePaise` at line-create (`schema.md` §4.6) — never client-supplied. Scoped to `outletId`. |
| PUT | `/api/inventory/adjustments/:id` | R(canManageInventory) | I | Full-replace of a draft: create body + `version`; `409 stale_version` on conflict. |
| POST | `/api/inventory/adjustments/:id/confirm` ‡ | R(canManageInventory) | I | Draft-only. Writes signed `adjustment_in`/`adjustment_out` per line against explicit batches (`sourceType=adjustment`). An out-line exceeding available stock rolls back the whole document — `409 insufficient_stock`, zero movements. Re-confirm → `409 invalid_transition`. |
| POST | `/api/inventory/adjustments/:id/void` | R(canManageInventory) | I | Draft only. |

## 5. Purchasing

| Method | Path | Guard | Idem | Notes |
|---|---|---|---|---|
| GET | `/api/vendors` | S | – | |
| POST | `/api/vendors` | R(canManagePurchases) | I | `{ name, phone, gstin? }`. |
| GET/POST | `/api/purchase-bills[/:id]` | R(canManagePurchases) | I on POST | Draft CRUD, items + signed charges. |
| PUT | `/api/purchase-bills/:id` | R(canManagePurchases) | I | Draft only; versioned. |
| POST | `/api/purchase-bills/:id/issue` ‡ | R(canManagePurchases) | I | Recomputes money (floor-tax rule), creates-or-reuses batches by `(variantId, batchNumber)`, writes `purchase` in-movements per line, snapshots totals. Every line must carry a `batchNumber` at issue (else `400`); an existing `(variantId, batchNumber)` batch is reused untouched, a missing one is created with `costPricePaise = unitCostPaise`. Re-issue → `409 already_issued`, zero rows. |
| POST | `/api/purchase-bills/:id/void` | R(canManagePurchases) | I | Draft only — never reverses stock. |

## 6. Sales

| Method | Path | Guard | Idem | Notes |
|---|---|---|---|---|
| GET/POST | `/api/orders[/:id]` | R(canManageSales) | I on POST | **Header-only**: `POST { orderType, customerId?, outletId }` — sale lines live on the linked draft invoice, never on the order row. |
| PUT | `/api/orders/:id` | R(canManageSales) | I | Draft only. |
| POST | `/api/orders/:id/confirm` ‡ | R(canManageSales) | I | `draft → confirmed`; creates the **empty** draft invoice. Plays no stock. |
| POST | `/api/orders/:id/cancel` ‡ | R(canManageSales) | I | `draft\|pending → cancelled`; voids the linked draft invoice. |
| GET | `/api/invoices[/:id]` | S | – | Detail includes computed outstanding balance (`totalPaise` − Σ in + Σ out over linked payments). |
| PUT | `/api/invoices/:id` | S | I | Draft only; versioned. Full-replace body: `{ items, charges?, version }` — regular lines `{ variantId, quantity }` are **re-priced server-side** (price/tax from the variant; a client-sent price on a regular line → 400), custom lines `{ isCustomItem: true, name, quantity, unitPricePaise }` keep the client price at `taxRatePct = 0`; duplicate regular `variantId` → 400. |
| POST | `/api/invoices/:id/issue` ‡ | R(canManageSales) | I | **The shared `issueInvoice` core** — recomputes totals from snapshots + charges, allocates batches FIFO, writes `sale` movements per line/batch, snapshots totals, marks `issued`. Re-issue → `409 already_issued`, zero rows; insufficient stock → `409`, whole document rolls back. |
| POST | `/api/invoices/:id/void` | R(canManageSales) | I | Draft only. |
| POST | `/api/invoices/:id/render-pdf` | R(canManageSales) | – | Body `{ html }` (≤256KB) — client-built markup, server only prints (`architecture.md` §4.9). Responds `{ pdfPath: string \| null }`. Non-fatal: failure → warning + null `pdfPath`, invoice stands. |
| POST | `/api/sales/pos/checkout` ‡ | R(canManageSales) | I | POS one-step sale: create + issue immediately in one transaction, via the same `issueInvoice` core. Body `{ outletId, customerId?, items, charges? }`. |

## 7. Payments

| Method | Path | Guard | Idem | Notes |
|---|---|---|---|---|
| GET | `/api/payments` | R(canManagePayments) | – | Filters `direction`, `partyType`/`partyId`, date range. |
| POST | `/api/payments` | R(canManagePayments) | I | `{ direction, partyType, partyId, invoiceId? \| purchaseBillId? \| returnId?, amountPaise, mode, outletId }` with **exactly one** document link (XOR, else 400), `mode` ∈ cash\|upi\|card\|bank (`gateway` → 400 — it only arrives via the webhook). Six contexts, one shape: `in`+customer+invoice (cap = invoice outstanding), `out`+customer+invoice (cap = invoice paid balance), `out`+vendor+bill (cap = bill outstanding), `in`+vendor+bill (cap = bill paid balance), `out`+customer+returnId (sales-return refund; cap = min(invoice paid balance, remaining return value)), `in`+vendor+returnId (purchase-return refund; cap = min(bill paid balance, remaining return value)). **Every cap violation is `409 over_payment`** — one reason per mechanism (`over_return` is reserved for return-document quantity caps at confirm). Balances are re-derived in-tx from confirmed rows only (a pending gateway placeholder has moved zero money) and include return-linked refunds inside the direction sums — two refund paths can never jointly exceed what was paid. The document must be `issued`/confirmed (else `409 invalid_transition`), `partyId` must be the document's own party (404/400), and the payment's outlet is the document's outlet (`outletId` mismatch → 400). Return-linked rows have the document's own invoice/bill id stamped by the service. |
| POST | `/api/webhooks/payments/:gateway` ‡ | * (signature-verified) | – | No idempotency header, no staff session (`architecture.md` §4.2). Body `{ event: "payment.confirmed", gatewayPaymentId, gatewayEventId }` (strict — **no money field**; the amount is derived server-side from the pending checkout row). Header `X-Webhook-Signature` = lowercase hex HMAC-SHA256 over the raw body with `WEBHOOK_SECRET_<GATEWAY>` (path param, uppercased). Order of checks: unknown gateway → `401 gateway_unknown`; missing/bad signature → `401 bad_signature` (both zero DB access); unparseable JSON → 400; unknown `gatewayPaymentId` → 404. Dedupe on `payments UNIQUE(gateway, gatewayEventId)` (R7): replay or race → `200 { status: "replayed" }` with zero side effects. Otherwise: insert the confirmed row → `payment.confirmed` event → pending order's confirm+issue path (final stock gate re-runs in-tx) → `200 { status: "confirmed" }`, cart cleared. A webhook arriving for an already-cancelled order inserts the confirmed row plus a full auto-refund `out` row (`payment.confirmed` + `payment.refunded` events) → `200 { status: "refunded" }` — the payment fact is never lost. A late stock shortfall auto-cancels the order, voids the invoice, and auto-refunds the same way (`architecture.md` §4.7). |

## 8. Returns & fulfillment

| Method | Path | Guard | Idem | Notes |
|---|---|---|---|---|
| GET/POST | `/api/returns[/:id]` | R(canManageReturns) | I on POST | `returnType` = `sales`\|`purchase`; exactly one of `orderId`/`purchaseBillId` (XOR, else 400). Lines `{ originalItemId, quantity }`: must reference the document's own line (404), `quantity` in 1..original (400), no duplicates (400), sales may not return custom lines (400). Outlet = the document's own. Draft plays no stock and writes no events (I11). |
| PUT | `/api/returns/:id` | R(canManageReturns) | I | Draft only (`409 invalid_transition`), versioned full-replace (`409 stale_version`), re-validated against the original document. |
| POST | `/api/returns/:id/confirm` ‡ | R(canManageReturns) | I | Draft only. Per-line returnable = `original.qty − Σ confirmed return lines of the same document` re-derived in-tx → `409 over_return`, whole document rolls back, zero movements. Sales restock mirrors the original allocations batch-for-batch (`return_in`); purchase de-stocks the bill's batch (`return_out`), gated in-tx on available stock → `409 insufficient_stock`. Unit price + tax re-snapshotted from the original line (tax pro-rated by quantity); sales writes its `return.confirmed` order event. |
| POST | `/api/returns/:id/void` | R(canManageReturns) | I | Draft only — a draft has no movements, so voiding never touches stock. |
| GET/POST | `/api/shipments[/:id]` | R(canManageFulfillment) | I on POST | Whole-invoice, no line quantities; invoice must be `issued` (else `409 invalid_transition`), scope = the invoice's outlet, one invoice may have many shipments. `SH-` numbers. |
| PUT | `/api/shipments/:id` | R(canManageFulfillment) | I | Carrier/AWB, while `created` only (`409 invalid_transition`); versioned (`409 stale_version`). |
| POST | `/api/shipments/:id/dispatch` ‡ | R(canManageFulfillment) | I | `created → dispatched`; writes `shipment.dispatched` on the invoice's order. |
| POST | `/api/shipments/:id/deliver` ‡ | R(canManageFulfillment) | I | `dispatched → delivered`; writes `shipment.delivered`. Shipment state never changes invoice/order state. |

## 9. Storefront (customer-facing)

| Method | Path | Guard | Idem | Notes |
|---|---|---|---|---|
| GET | `/api/storefront/products` | * | – | `isCustomerVisible` variants only; stock exposed only as `isInStock` — **never quantity**. Products with no visible variant are excluded entirely. |
| GET | `/api/storefront/products/:slug` | * | – | Product detail; 404 when the product has no visible variant. |
| GET | `/api/storefront/cart` | C | – | Current cart, cross-device (keyed by `customerId`). |
| PUT | `/api/storefront/cart` | C | I | Upsert `{ variantId, quantity }`. |
| DELETE | `/api/storefront/cart/:variantId` | C | I | |
| GET/POST/DELETE | `/api/storefront/wishlist[/:variantId]` | C | I on POST/DELETE | |
| GET/POST | `/api/storefront/addresses[/:id]` | C | I on POST | Own rows only. |
| POST | `/api/storefront/checkout` ‡ | C | I (rate-limited 5/min) | Body `{ custAddressId, paymentMode }` **only — no prices, no cart snapshot**. Re-reads the cart, re-prices every line from `variants`, re-derives stock in-tx (`architecture.md` §4.11). `cod` confirms + issues immediately and clears the cart; `gateway` pre-gates stock but allocates nothing — order stays `pending`, invoice stays `draft`, a `pending` payment row is inserted and its `gatewayPaymentId` is returned as `checkoutReference`; the cart is kept until the phase-8 webhook confirms. On any gate failure, the whole transaction rolls back and the cart is untouched. Storefront outlet = `settings.defaultOutletId` else first active outlet; none → 500 `no outlet configured`. |
| GET | `/api/storefront/orders[/:id]` | C | – | List own orders (any status); detail returns own orders only (404 on others'), including the `order_events` timeline. |
| POST | `/api/storefront/orders/:id/cancel` ‡ | C | I | `pending` only; voids the linked draft invoice. |
| POST | `/api/storefront/returns` | C | I | Draft sales return on the customer's own order whose invoice is `issued` (order must be `confirmed`, else `409 invalid_transition`; invoice not `issued` → 404). Lines `{ originalItemId, quantity }` must reference the invoice's own line (404 otherwise), `quantity` ≤ original (400), custom-line returns rejected (400). Caps enforced at staff-side confirm (§8). |

The client never treats a gateway redirect as success — it polls/subscribes to
`order:{id}` until status leaves `awaiting_payment`.

## 10. Realtime & ops

| Method | Path | Guard | Notes |
|---|---|---|---|
| WS | `/api/ws` | S \| C | Upgrade requires a valid session. Subscribe frame: `{ op: "subscribe", topics: [...] }`. Topics: `order:{id}`, `invoice:{id}`, `stock:{outletId}` — authorized per topic (`architecture.md` §4.8). |
| GET | `/api/health` | * | Never `500` for a reportable DB condition — a degraded-but-queryable DB reports `{ status: "degraded" }` at `200`, so uptime monitors alert on body content. Returns `{ status, dbTimeMs, ledgerCounts }` with `ledgerCounts: { stockMovements, payments, orderEvents, auditEvents }`; each ledger is counted in its own try/catch so a missing/corrupt table drops that key (partial counts) without failing the request. |
| GET | `/api/audit` | R(canManageStaff) | Reads `audit_events`, newest first, deterministic tie-break on `id`. Filters `entityType` (closed enum), `entityId`, `actorId` (uids), `from`/`to` (epoch-ms) — all optional, combined with AND; `page`/`pageSize` (`pageSize ≤ 100`). Response `{ data, pagination: { page, pageSize, total } }`. |

---

## 11. Route inventory summary (for `verify-routes`)

~93 routes across 10 domain sections above plus better-auth's mounted paths. The
checker reads every row in §1–§10 and every route mounted on `app.routes`, and asserts
the two sets are equal in both directions — nothing documented-but-unimplemented,
nothing implemented-but-undocumented.
