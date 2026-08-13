# Vitrine — Build Plan (todo)

Phase-gated execution of `task.md`. One git commit per phase,
`phase N: <slug>`, in order, none bundling two phases. A phase is complete only when
its exit condition is green — verified by script or test, never "looks done."

**Read the Session Log (§ bottom) first — it is the source of truth for where work
stopped.** Before starting any phase and before committing it, follow `AGENTS.md` §1.

---

## Phase 0 — Scaffolding

- [x] Scaffold with the Bun default template: `bun init -y` — one `package.json`,
      `tsconfig.json`, `index.ts`, `README.md`, `@types/bun`, one `bun.lock`.
- [x] Harden the root `tsconfig.json` inherited from the template: `strict: true`,
      `types: ["bun"]`, `noUncheckedIndexedAccess`, `noUnusedLocals`,
      `noUnusedParameters`, `verbatimModuleSyntax` (+ `esModuleInterop`, see Session
      Log 2026-08-13).
- [x] Install every dependency from `architecture.md` §2 via `bun add <pkg>` (dev tools
      with `bun add -d <pkg>`) — no hand-pinned versions, Bun resolves latest. TypeScript
      stays as `bun init -y` provides it (peer dependency) — no separate `bun add`.
- [x] Add `package.json` scripts — `dev`, `typecheck` (`bunx tsc --noEmit`), `ci` (the
      `audit.md` §2 chain) — `bun run` / `bunx` only. (`ci` grows per phase; phase 0 =
      typecheck.)
- [x] `lib/logger.ts` (pino singleton), `lib/db.ts` (`withTx`, WAL pragma on boot).
- [x] `.env.example` covering every var in `architecture.md` §4.16.
- [x] Verify a Chrome/Chromium/Edge binary is discoverable (`BUN_CHROME_PATH` or PATH)
      for later PDF work. — **absent** in this workspace; not installed per operator
      instruction; phase 9 exercises the documented missing-renderer non-fatal path.
- [x] Git init; initial commit. (Repo + AGENTS.md already committed as `094c496 init`;
      nothing further needed.)


**Exit:** `bun run typecheck` passes on an empty workspace; `bun run dev` boots and
serves `GET /api/health` → `200`. Commit `phase 0: scaffolding`.

## Phase 1 — Schema & migrations

- [x] All 38 tables from `schema.md` as Drizzle schema files, one file per domain group
      (`schema.md` §3–§13).
- [x] Immutability triggers on all four `[FACT]` tables.
- [x] `drizzle-kit generate` + apply against a fresh file.
- [x] `scripts/verify-db.ts`.

**Exit:** `verify-db` green (38 tables, WAL, triggers, 0 CHECKs, no REAL, all partial
UNIQUEs). Commit `phase 1: schema`.

## Phase 2 — Auth, RBAC, bootstrap admin

- [x] Mount `better-auth` (`lib/auth.ts`); define its four tables for
      `drizzle-kit`.
- [x] `databaseHooks.user.create.after` → auto-provision `customers` row.
- [x] `requireStaff` / `requireCustomer` / `requireCapability` guards
      (`architecture.md` §4.14), null-safe (403, never 500).
- [x] Bootstrap-admin boot step (`SUPERUSER_*`), idempotent; seed `Admin` role.
- [x] `scripts/verify-rbac.ts` + RBAC scenario tests (`audit.md` §4).

**Exit:** sign-up creates a customer profile automatically; bootstrap admin exists
after first boot and is undeletable (`409 protected_resource`); a capability-gated call
without the capability returns `403`, never `500`; fresh boot → exactly one
`isProtected` profile. Commit `phase 2: auth`.

## Phase 3 — Idempotency, errors, money, doc numbers

- [x] `lib/idempotency.ts` (`withIdempotency`), `lib/errors.ts` (envelope, codes,
      `app.onError`/`notFound`), `lib/money.ts` (floor-tax rule), `lib/doc-number.ts`.
- [x] `Bun.cron` idempotency-key reaper (24h TTL).
- [x] `scripts/verify-hygiene.ts`, `scripts/verify-deps.ts`,
      `scripts/verify-immutability.ts`.

**Exit:** scenario tests for R1 (replay byte-identical, mismatch → 409, concurrent
same-key single execution) and the crash-mid-transaction test pass; reaper deletes
expired rows on a manual trigger in test; hygiene/deps/immutability checks green.
Commit `phase 3: core`.

## Phase 4 — Catalog, inventory, stock projection, audit wiring begins

- [x] Catalog CRUD services (`api.md` §3: categories/products/variants) with
      `audit_events` writes on every mutation.
- [x] Batch creation, `stock_movements` writes, `stock_levels` projection maintenance
      (the one projector, `architecture.md` §4.6).
- [x] FIFO-by-expiry batch allocation helper (`allocateBatches`), pure, unit-tested
      standalone.
- [x] `scripts/verify-stock.ts`, `scripts/verify-audit.ts`.
- [x] `smoke-catalog.ts`.

**Exit:** `verify-stock` and `verify-audit` both green; reads correct on an empty DB
(zero `stock_levels`); a manual-adjustment-style scenario race passes. Commit
`phase 4: catalog`.

## Phase 5 — Inventory: transfers & adjustments, media

- [x] Transfer draft → confirm (atomic, whole-doc rollback on insufficient stock) →
      void; adjustment create → confirm → void.
- [x] Media upload/delete (`api.md` §3) with thumbnailing (`Bun.Image`) and
      `audit_events` writes.
- [x] `smoke-inventory.ts`, `smoke-media.ts`.

**Exit:** 3+ line transfer atomic; insufficient-stock rolls back the whole transfer,
zero movements; re-confirm → 409 zero movements; media upload produces a thumbnail
and an audit row; `verify-stock` still green. Commit `phase 5: inventory`.

## Phase 6 — Purchasing

- [x] Vendor bill draft CRUD (items + signed charges); `issue` — recompute totals,
      create-or-reuse batches by `(variantId, batchNumber)`, write `purchase`
      movements per line, snapshot totals; void (draft only).
- [x] Vendor payment recording (shared `recordPayment` service — also used by §9).
- [x] `smoke-purchasing.ts`.

**Exit:** multi-line bill → exactly one `stock_movements` row per line; re-issue →
409, zero duplicate movements; partial vendor payments capped correctly; `bun run ci`
green. Commit `phase 6: purchasing`.

## Phase 7 — Sales core, cart & wishlist, storefront

- [ ] Orders CRUD (manual/POS); invoice draft CRUD; **`issueInvoice`** shared core
      (recompute from snapshots + charges, FIFO allocation, stock gate, `sale`
      movements, `invoice.issued`); POS one-step checkout.
- [ ] Cart/wishlist CRUD; storefront public catalog (`isInStock` only, never
      quantity); storefront checkout — full server-side re-derivation
      (`architecture.md` §4.11), COD issues immediately, gateway defers with a stock
      pre-gate.
- [ ] `smoke-sales.ts`, `smoke-storefront.ts`.

**Exit:** POS sale drops stock instantly; draft quote touches zero stock; double-issue
→ 409, zero extra rows; client-sent prices ignored, custom lines honored; last-unit
checkout race → exactly one 200 + one 409, final quantity 0 (never −1, never 1);
stale-cart checkout re-prices correctly; own-orders isolation (404 on others').
Commit `phase 7: sales-storefront`.

## Phase 8 — Payments, webhooks, returns, fulfillment

- [ ] Unified `payments` service (in/out, all five flows, one shape), balance/cap
      computations (R3).
- [ ] Gateway webhook route: HMAC verification before any DB access, provider-event
      dedupe (R7), pending-order confirm+issue path with the auto-cancel+refund
      compensation on a late stock shortfall.
- [ ] Returns (sales + purchase) with allocation-mirroring restock, over-return cap
      (R4).
- [ ] Shipments (create → dispatch → deliver, whole-invoice).
- [ ] `smoke-payments.ts`, `smoke-returns.ts`, `smoke-fulfillment.ts`.

**Exit:** webhook-replay scenario passes with zero side effects on the second
delivery; bad/missing signature → 401, zero rows; over-return and over-payment both
return 409 with the whole document rolled back; sales restock mirrors exact
allocations; `bun run ci` green. Commit `phase 8: payments-returns-fulfillment`.

## Phase 9 — Realtime, PDF

- [ ] WebSocket hub at `/api/ws`, three topics, subscription authorization
      (`architecture.md` §4.8).
- [ ] Publish-after-commit wiring on every `‡`-marked route in `api.md`.
- [ ] `Bun.WebView` PDF printer (`architecture.md` §4.9), non-fatal failure path,
      manual retry via re-post.
- [ ] `scripts/verify-realtime.ts` (grep backstop — no publish call site inside a
      `withTx` body, even though the compiler already forbids it).

**Exit:** four distinct event types observed live in an integration test; a
PDF-renderer-missing test confirms the parent invoice-issue call still succeeds,
`pdfPath` stays null; `bun run ci` green. Commit `phase 9: realtime-pdf`.

## Phase 10 — CI hardening, ops

- [ ] `verify-routes.ts`, `verify-deps.ts` (final pass), `verify-hygiene.ts` (final
      pass).
- [ ] `GET /api/health` — never 500 for a reportable DB issue.
- [ ] Rate limiting on `/api/auth/*` (30/min) and `/api/storefront/checkout` (5/min).
- [ ] Nightly backup `Bun.cron` job + 30-day prune (`architecture.md` §4.18).
- [ ] Full `bun run ci` wired end to end, in the order given in `audit.md` §2.
- [ ] `smoke-ops.ts`.

**Exit:** `bun run ci` green from a cold clone; a simulated corrupt-backup-target test
confirms the process stays up; a manually restored backup passes `verify-stock`
(`audit.md` §6). Commit `phase 10: ops`.

## Phase 11 — Full audit & sign-off

- [ ] Execute `audit.md` §1–§6 end-to-end on a fresh DB: all invariants I1–I11, all
      scenario tests (R1–R9 + crash-mid-transaction), the RBAC matrix, route-coverage
      audit.
- [ ] Every route in `api.md` mounted and no others (`verify-routes` both directions).
- [ ] Leftover issues → fix-forward tasks in this same phase, re-run `bun run ci`.
- [ ] `todo.md` fully checked; Session Log ends with a clean entry.

**Exit:** `task.md` §6 (Definition of Done) wholly satisfied. Commit `phase 11: audit`.

---

## Session Log

The source of truth for where work stopped. One row per phase commit — date, phase,
what passed, what changed in the docs (if anything). Read this table first, every
time, before starting the next phase (`AGENTS.md` §1 and §7).

| Date | Phase | Note |
| ---- | ----- | ---- |
| 2026-08-13 | 6 — purchasing | Exit green: `bun run ci` end-to-end (typecheck + verify:db + verify:rbac + test:rbac 12/12 + verify:immutability + verify:hygiene + verify:deps + verify:stock + verify:audit 14 routes + smoke:catalog + smoke:media + smoke:inventory + smoke:purchasing + test:core 17/17 + test:stock 7/7); `bunx drizzle-kit generate` → zero schema drift (vendor/bill/payment tables landed in phase 1); boot smoke on `PORT=3111` with `AUTH_SECRET` (`/api/health` 200 `{"status":"ok",…}`, `/api/vendors` 401 unauthenticated — mounted + guarded). Delivered: `services/purchasing.ts` (vendor create — audited `vendor` entity, no update route per api.md; `createVendor`/`listVendors`; bill draft CRUD — `createBill`/`updateBill` full-replace with version bump → `409 stale_version` (R5), draft-only edits → `409 invalid_transition`, header totals ALWAYS derived in-service from line/charge snapshots (`subtotal = Σ unitCost×qty`, `tax = Σ floor-tax`, `total = subtotal+tax+Σ signed charges`) — stored on the draft write, recomputed at issue (I4), never a client field; `issueBill` — every line must carry `batchNumber` (400 `batch number required`, batchNumber is the create-or-reuse key), `findOrCreateBatch` create-or-reuse by `(variantId, batchNumber)` (reuse leaves the batch untouched — create only, with `costPricePaise = unitCostPaise`; UNIQUE backstop → `409 duplicate_batch` R6), line money re-derived from stored snapshots, `total ≥ 0` enforced (400), exactly one `purchase` in-movement per line (`sourceType=purchase`, `sourceId`=bill id, fact rows before the header status flip, T3), non-draft → `409 already_issued` zero rows; `voidBill` draft-only, zero stock effects), `services/payments.ts` (`recordPayment` — the shared one payment write path, phase 6 supports the vendor context only (`direction=out, partyType=vendor, purchaseBillId`), XOR exactly-one document link (400), vendor/bill existence 404, `partyId` must equal the bill's own `vendorId` (400 `party mismatch` — never trusted from the payload), bill must be `issued` (409 `invalid_transition`), R3 cap re-derived in-tx as `bill.total − Σ payments(direction='out', link=bill)` → `409 over_payment` zero rows, `PY-` doc number, `status=confirmed` (pending is gateway-only), no audit row — payments is a [FACT] domain per §4.12; `listPayments` — filters `direction`/`partyType`/`partyId`/`from`/`to`, deterministic order), `routes/purchasing.ts` + `routes/payments.ts` (mounted `app.route("/api", …)`; payment zod: `amountPaise ≥ 1`, `mode` enum without `gateway` — the gateway flow + `in`/refund/return contexts are phase 8, as is the mode; unsupported contexts → 400 `unsupported payment context`, no new reason code added), `scripts/smoke-purchasing.ts` (vendor CRUD + list; 3-line bill: draft totals exact (34600/3600/41200), stale PUT 409, versioned PUT recompute (44560), issue → exactly 3 movements + per-batch stock + create-or-reuse (BP-EXIST id unchanged, cost untouched on reuse; new batches cost = line unit cost), re-issue 409 zero rows, PUT/void on issued 409, void draft → issue-voided 409 zero movements, batchless issue 400 zero rows; payments: partial 200 → over 409 `over_payment` zero rows → remainder 200 → settled-bill payment 409, draft-bill payment 409 `invalid_transition`, no-link 400, unsupported context 400, bad vendor/bill 404, party mismatch 400, gateway mode 400, list + date-range filters). **Docs changed (spec defects, AGENTS.md §4):** (1) architecture.md §4.12 — `vendors` joined the audited trigger-point list (a vendor record is reference data like any catalog row; `customers` explicitly stay out — auth-hook provisioned, never a staff route); `services/audit.ts` + `verify-audit` entries for `POST /api/vendors` (vendor) and `POST /api/purchase-bills/:id/issue` (batch — created at issue, audited only on the create path). (2) api.md §5 issue row — `batchNumber` required at issue (400), reuse semantics (existing batch untouched, created with `costPricePaise = unitCostPaise`). (3) api.md §7 payments row — exactly-one XOR link, linked document must be issued (409 `invalid_transition`), `partyId` must be the document's own party. Phase-boundary note: the §7 route is mounted with the vendor flow; invoice/refund/gateway contexts arrive with phases 7–8, and the `mode` enum gains `gateway` then. No schema change (zero drift). Realtime `‡` wiring on issue remains phase 9 (no publish calls from services, per the T3/invariant-2 rule). |
| 2026-08-13 | 5 — inventory | Exit green: `bun run ci` end-to-end (typecheck + verify:db + verify:rbac + test:rbac 12/12 + verify:immutability + verify:hygiene + verify:deps + verify:stock + verify:audit 12 routes + smoke:catalog + smoke:media + smoke:inventory + test:core 17/17 + test:stock 7/7); `bunx drizzle-kit generate` → zero schema drift (no new migrations — transfer/adjustment/media tables landed in phase 1); boot smoke on `PORT=3107` with `AUTH_SECRET` (`/api/health` 200 `{"status":"ok",…}`, `/api/categories` 200 public). Delivered: `services/inventory.ts` (transfer/adjustment drafts — `freshDocNumber("TR"/"AJ")` collision check (`lib/doc-number.ts`), outlet/variant/batch existence → 404, batch-variant mismatch → 400, duplicate `(variantId,batchId)` line → 400, quantity policy `positive` (transfers) vs `nonzero` (signed adjustments) via `assertTransferLines(…, policy)`; drafts `version: 1`, PUT = full-replace with version bump via `WHERE id AND version` → `409 stale_version` (R5); confirm draft-only → `409 invalid_transition` on re-confirm, per-line in-tx gate on `sumStockAtBatch` (R2) — whole-doc atomic, one insufficient line → `409 insufficient_stock`, zero movements; paired `transfer_out`@from/`transfer_in`@to and signed `adjustment_in`/`adjustment_out` per line, `sourceType` + `sourceId` = doc id (facts before header state, T3; no realtime from services); `unitValuePaise` server-derived from `batches.costPricePaise` at line-create, never client-supplied; list totals via `db.select({n:count()})`, deterministic `(createdAt DESC, id DESC)`; transfers span two outlets → **no outlet scope** (outlet-scoped roles 403), adjustments scoped to `outletId`), `services/media.ts` (`MEDIA_MIME_TYPES` jpeg/png/webp, `MEDIA_MAX_BYTES` 8MiB, `mimeExt`, `makeThumbnail` — resolved 1.3.14 `Bun.Image` chain `.resize(400, undefined, {fit:"inside", withoutEnlargement:true}).webp({quality:80}).bytes()`, decode failure → 400 `image decode failed`; `uploadMedia`/`deleteMedia` — one tx each, `audit_events` created/deleted; delete returns `{id, deleted:true}`), `lib/storage.ts` (StorageAdapter `put/get/delete`; local `STORAGE_DIR` (default `data/storage`) vs `Bun.S3Client` branch when `S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`S3_BUCKET` set — boot-time env check; `client.file(path).exists()/.arrayBuffer()` verified), `routes/inventory.ts` (11 routes: batches, stock-levels, transfers + adjustments GET list (R(canManageInventory))/detail (S)/POST/PUT/confirm/void, all mutating via `withIdempotency` + `respondIdempotent`; `statusQuery` filter; confirm/void body `jsonValidator(z.object({}))`), `routes/catalog.ts` (media: GET/POST `/products/:id/media`, `/variants/:id/media` (owner 404 pre-check), GET `/api/media/:id` serves original bytes with `content-type: mimeType` (spec gap — added route), DELETE pre-reads row then `withIdempotency` + `cleanupFiles` only when `!replayed`; `handleUpload` — multipart `{file, altText?}`, size ≤8MB, altText ≤500, storage files written *before* the tx (T1), idempotency body hash binds file sha256 → same key + different bytes `409 idempotency_mismatch`, cleanup on replay/rollback/error; `logger.warn` on cleanup failure), `scripts/smoke-inventory.ts` (outlet B via direct `tx.insert(outlets)` — no outlet routes until phase 2-of-settings; seed stock via 3-line positive adjustment confirm; 3-line transfer A→B → exactly 6 movements + moved stock; re-confirm 409 zero movements; PUT on confirmed 409; insufficient transfer confirm 409 `insufficient_stock` zero movements + stock untouched; stale PUT 409 `stale_version`; void draft + confirm-after-void 409; from==to 400; negative adjustment confirm decrements; over-adjust 409 zero movements; zero-quantity line 400; `unitValuePaise` == batch cost; list status filters + pagination), `scripts/smoke-media.ts` (1×1 PNG (canonical base64 — hand-rolled bytes fail Bun's lazy decode) upload → media row + WebP thumbnail (RIFF/WEBP magic) + audit row; same-key replay `Idempotency-Replayed: true` no dup row; same key + different bytes 409 mismatch; GET serves byte-identical with right content-type; bad MIME 400; >8MB 400; missing idempotency key 400; variant-owner upload; unknown owner 404; DELETE removes row + both storage files + audit `deleted`; media survive owner deactivation (no cascade); serve deleted → 404), package.json (`smoke:media` + `smoke:inventory` wired into `ci` between smoke:catalog and test:core, per audit.md §2/§3), verify-audit += 3 media mutation rows (product/variant upload + delete → `services/media.ts`, entityType `media`). **Docs changed (spec defects/ambiguities, AGENTS.md §4):** (1) api.md §4 rewritten — transfer/adjustment bodies, PUT = full-replace + `version` (`409 stale_version`), `status` list filter, draft-only confirm/void + re-confirm `409 invalid_transition`, adjustments scoped to `outletId` vs transfers with no outlet scope (they span two outlets — previously unsaid), signed adjustment quantities, `unitValuePaise` server-derived. (2) api.md §3 — added `GET /api/media/:id` serve route (spec gap: no way to fetch media bytes), multipart `{file, altText?}`, upload idempotency binds file sha256, file lifecycle (written pre-tx, removed on replay/rollback), media survive owner deactivation. (3) schema.md §4.6 — `adjustment_items.unitValuePaise` never client-supplied, derived from `batches.costPricePaise` at line-create in-tx. (4) architecture.md §4.10 — effective MIME comes from the **filename extension** (Bun's multipart parser derives `File.type` from the extension, ignoring the declared part Content-Type — verified §6); corrupt-but-valid-MIME → 400 decode failure; serve route; file lifecycle. (5) architecture.md §6 — stale `Bun.Image` row corrected to the resolved 1.3.14 API (`.resize(w, h?, opts)` + `.webp({quality}).bytes()`, lazy decode; `.encode("webp")` does not exist); `Bun.S3` row expanded (`write(path, data, {type})`, `delete`, `file(path)` lazy + `exists()`/`arrayBuffer()`); new row for multipart filename inference. |
| 2026-08-13 | 4 — catalog | Exit green: `bun run ci` end-to-end (typecheck + verify:db + verify:rbac + test:rbac 12/12 + verify:immutability + verify:hygiene + verify:deps + verify:stock + verify:audit 9 routes + smoke:catalog + test:core 17/17 + test:stock 7/7); boot smoke on `PORT=3107/3108` with `AUTH_SECRET` (health 200 `{"status":"ok"}`, `/api/categories` 200 public). Delivered: `services/catalog.ts` (`slugifyName`; `createCategory`/`updateCategory` — parent 404, walk-up cycle → `409 category_cycle`; `createProduct` — duplicate slug → `409 duplicate_slug` + UNIQUE backstop, creates base variant (`isBase=1`, `isTaxable=1`, `isCustomerVisible=1`) in the same tx, audits product+variant; `updateProduct` — slug immutable; `deactivateProduct` — no audit row when already inactive; `createVariant` — duplicate `sku`/`barcode` → `409 duplicate_sku`, `mrpPaise` defaults to `sellingPricePaise`; `updateVariant` — self-excluding dup checks), `services/stock.ts` (`writeMovement` — the one projector, inserts the fact row + upserts `stock_levels` via increment, `lastMovementId`/`updatedAt` = the movement's own id/createdAt so an `(createdAt,id)` replay is byte-identical; `sumStock`/`sumStockAtBatch` — decision reads, `coalesce(sum(delta),0)` in-tx, never the cache; `allocateBatches` — pure FIFO-by-expiry `(expiryDate ASC, nulls last, batchId tie-break)`, skips `≤0` holdings, `null` when insufficient; `createBatch` — `UNIQUE(variantId,batchNumber)` → `409 duplicate_batch`, audits; `listStockLevels` — display-only join), `routes/catalog.ts` + `routes/inventory.ts` (sub-apps, mounted `app.route("/api", …)` — routePath verified to include the mount prefix so idempotency operations are full paths; `jsonValidator`/`queryValidator`/`paramValidator` in `lib/validate.ts` wrapping `zValidator` with the throwing 400 hook; `paise = z.number().int().min(0)`, `z.uuid()`, `z.coerce.number()` page params, `z.enum(["0","1"])` active filters; GETs public per api.md `*`, stock-levels `S`), `app.ts` (hooks + `/api/auth/*` + `/api/health` + mounts, `export type AppType`; `index.ts` slimmed to migrate+bootstrap+serve+cron), `scripts/verify-stock.ts` (seed via services, replay byte-compare incl. `lastMovementId`/`updatedAt`, empty reads zero rows), `scripts/verify-audit.ts` (route → service file → entityType table, 9 mutations), `scripts/smoke-catalog.ts` (sign-in, public read 200, `S` read 401, missing idempotency key 400, create+replay `Idempotency-Replayed: true`+mismatch 409, cycle 409, duplicate slug/sku/batch 409s, deactivate, zero `stock_levels` on fresh DB and for a stock-less batch, audit rows per entity), `test/stock.test.ts` (7 tests: allocateBatches unit matrix, projector byte-identical replay, R2 manual-adjustment-style race via `test/fixtures/adjust-worker.ts` — two spawned consumers on one unit → exits exactly `{0,3}`, final quantity 0, exactly 2 movements). **Docs changed (spec defects, AGENTS.md §4):** (1) `products.categoryId` — schema.md said NOT NULL but api.md has always marked it optional (`categoryId?`); uncategorized products are legal. Schema made nullable; new migration `0001_products_category_nullable.sql` (drizzle-kit table-rebuild), schema.md §3.2 updated; verify-db unaffected (no nullability assertions). (2) `category_cycle` added to the closed reason vocabulary (lib/errors.ts REASON_CODES + architecture.md §4.13 + api.md §3). (3) Layout — new `routes/` dir + root `app.ts` (architecture.md §4.15 rows for Layout, Route layer, Slugs); verify-hygiene/verify-deps/verify-immutability scan scopes extended (`routes/`, `app.ts`; immutability additionally applies the whole migration set, not just `0000`). (4) verify-hygiene client-origin money allowlist += `costPricePaise`/`sellingPricePaise`/`mrpPaise` (catalog master data is client-originable — architecture.md §4.4 already said so; audit.md §2 row 7 noted). (5) verify-deps deferred list emptied — `zod`/`@hono/zod-validator` now imported at the route boundary (audit.md §2 row 8). (6) R2 in audit.md §4 restated as the manual-adjustment race that actually landed; checkout variant comes with the sales phase. (7) architecture.md §6 += zod v4 `z.uuid()` (deprecation verified in installed types), `z.coerce.number()`, and the validator-wrapper constraint. `ci` grew: verify:stock + verify:audit + smoke:catalog + test:stock. |
| 2026-08-13 | 3 — core | Exit green: `bun run ci` end-to-end (typecheck + verify:db + verify:rbac + test:rbac 12/12 + verify:immutability + verify:hygiene + verify:deps + test:core 17/17); boot smoke on `PORT=3100` with `AUTH_SECRET` set (health 200, unknown route → 404 envelope `{code:NOT_FOUND,reason:not_found}`, sign-up 200); `bunx drizzle-kit generate` → zero schema drift. Delivered: `lib/idempotency.ts` (`withIdempotency` — missing key 400 `idempotency_key_required`, replay byte-for-byte with `Idempotency-Replayed: true`, mismatch 409 `idempotency_mismatch`, hash = sha256(canonicalJson(body??null)+"\n"+actorId), row+work in one `immediate` tx, run callback returns the response body verbatim; `respondIdempotent`; `reapExpiredIdempotencyKeys` — count-then-delete inside `withTx` (bun-sqlite tx `.run()` types as `void`, so no `.changes` read), non-fatal), `lib/errors.ts` (envelope, status→code map, Zod `cause.issues` → `details` duck-typed, unknown errors logged `INTERNAL` 500 never leaked), `lib/money.ts` (floor-tax + line-total), `lib/doc-number.ts` (RFC 4648 base32, 7×5 random bits), `index.ts` (onError/notFound + `Bun.cron("0 3 * * *")` reaper), `db/schema/system.ts` (`responseSnapshot` → plain TEXT, no JSON mode — verbatim bytes; SQL unchanged, zero drift), `scripts/verify-immutability.ts` (scratch-DB UPDATE/DELETE → ABORT on all 4 [FACT] tables + production-dirs grep), `verify-hygiene.ts` (console/any/banned-deps/tsconfig/typecheck/client-origin money scan), `verify-deps.ts` (imports↔declared both directions), `test/core.test.ts` (17 tests: doc-number, money floor, service-level idempotency incl. rollback-together and actor-binding, R1 HTTP envelope incl. concurrent single-execution, reaper manual trigger, crash-mid-transaction via `Bun.spawn` of `test/fixtures/crash-worker.ts` — worker dies at `process.exit(1)` inside the tx callback, verify worker reopens the same file and replays the key cleanly). `ci` = typecheck + verify:db + verify:rbac + test:rbac + verify:immutability + verify:hygiene + verify:deps + test:core. **Docs changed (spec defects/clarifications, AGENTS.md §4):** (1) §4.2 now defines the exact `requestHash` concatenation and the `withIdempotency` contract (operation = `c.req.method + " " + c.req.routePath`; run returns the response body; reaper registered in `index.ts`, never fatal). (2) §4.15 doc-number row: RFC 4648 base32 alphabet + regenerate-on-UNIQUE-violation contract (the spec said only "7 base32 chars"). (3) schema.md §12.1: `responseSnapshot` stored verbatim as plain TEXT (no JSON mode). (4) audit.md §2 rows 3/7/8: scan scopes made explicit (immutability grep = lib/db/scripts + index.ts, tests exempt; hygiene = code dirs + root files, self-file excluded; deps = same dirs + index.ts, with tooling allowlist `typescript`/`@types/bun`/`drizzle-kit` and deferred-import list `@hono/zod-validator`+`zod` → phase 4 route boundaries, must be empty or justified at sign-off). |
| 2026-08-13 | 2 — auth | Exit green: `bun run verify:rbac` PASS, `bun run test:rbac` 12/12, `bun run typecheck` + `verify:db` green, `bun run ci` green; boot smoke on `PORT=3100` (port 3000 is this workspace's other service): `/api/health` 200, sign-up 200, session round-trip 200 with correct email, exactly one `isProtected` profile. Delivered: `lib/auth.ts` (better-auth mount, `ALL_CAPABILITIES`, `isCapability`, idempotent `bootstrapAdmin` — seeds `Admin` role (9 caps, global), default outlet `"Main Outlet"` when none exists, admin user via `auth.api.signUpEmail`, protected profile; audit rows `actorId "system"`, `actorType "system"`; throws when `SUPERUSER_*` set without `AUTH_SECRET`), `services/rbac.ts` (`requireStaff`/`requireCustomer`/`requireCapability`, HTTPException, strict outlet-scope rule), `services/audit.ts` (`writeAuditEvent`), `services/staff.ts` (`deactivateStaffProfile`: 404 `not_found`, 409 `protected_resource`), `index.ts` (mount `/api/auth/*`, boot `await bootstrapAdmin()`), `scripts/verify-rbac.ts`, `test/rbac.test.ts`, `ci` = typecheck + verify:db + verify:rbac + test:rbac. **Docs changed (spec-vs-resolved-version defects, AGENTS.md §4):** (1) drizzle adapter — resolved 1.6.27 throws `BetterAuthError: model "user" was not found` without the schema object; §6 row updated to the real shape (`schema: { user, session, account, verification }`, `transaction: true`), and the adapter declares neither `supportsDates` nor `supportsBooleans`, so raw `Date`/`boolean` would hit bun:sqlite (`Binding expected …` on every create) — auth tables now carry drizzle modes `integer(name, { mode: "timestamp_ms" | "boolean" })` (SQL unchanged: still INTEGER ms / 0-1; `db:generate` confirms zero drift); documented schema.md §13 + §1. (2) `emailAndPassword.enabled` defaults false — §6 row added. (3) better-auth's built-in rate limiter trips under burst sign-ups in scripts/tests (default `3` per `10s` per IP on sign-up/sign-in) — disabled under `NODE_ENV=test`/`TEST=true` (`rateLimit.customRules["*"] = false`, production keeps defaults); §4.14 rate-limiting paragraph rewritten to match reality (the 30/min /api/auth/* figure was stale; specific limits land with their phases). (4) guard contract — guards throw Hono `HTTPException` (envelope is phase 3); strict outlet-scope semantics written into §4.14 (scopedOutletId must equal `actor.outletId` for outlet-scoped roles; unscoped ops denied to outlet-scoped actors; global roles unrestricted). (5) bootstrap now seeds the default outlet `"Main Outlet"` (spec gap — first boot needs one); documented §4.14. (6) layout §4.15 adds `services/` and `test/`. **Scheduling observation:** api.md §2 staff/roles/settings HTTP routes (incl. `POST /api/staff/:id/deactivate`) deliberately NOT built this phase — mutating routes need `withIdempotency` (phase 3); the 403/404/409 deactivation contract is exercised at the service level in verify-rbac + rbac.test. |
| 2026-08-13 | 1 — schema | Exit green: `bun run scripts/verify-db.ts` PASS — 38 tables, exact column order per `schema.md` §3–§13, exact FK set (restrict/cascade per §15), 49 indexes (24 unique incl. all 6 partial UNIQUEs), composite PK `stock_levels(variantId, outletId, batchId)`, `journal_mode = wal`, `foreign_keys = 1`, 0 CHECK constraints, 0 REAL columns, 8 immutability triggers present (4 tables × update/delete). `bun run typecheck` green; `bun run ci` green; fresh-file migration verified (delete `data/vitrine.sqlite` → boot re-creates 38 tables); `bun run dev` boots, `/api/health` → 200. **Docs changed (spec defects, AGENTS.md §4):** (1) layout — docs said `src/lib/*` / `src/db/schema/*` but phase 0 established root `lib/`; fixed schema.md §13, todo.md, audit.md §2, task.md, added Layout row to architecture.md §4.15. (2) FK enforcement — `bun:sqlite` defaults `PRAGMA foreign_keys = 0`, so every FK in schema.md would have been decorative; added boot `PRAGMA foreign_keys = ON` (lib/db.ts) and documented it in architecture.md §4.1 + schema.md §1; verify-db asserts it. (3) `stock_levels.lastMovementId` — clarified no FK (denormalized pointer, like `stock_movements.sourceId`), schema.md §4.1. (4) migrations-at-boot — architecture.md §4.1 now states boot runs `migrate(db, { migrationsFolder })`; §6 rows added for `migrate()` and the sqlite schema builder shapes. Migration: `0000_initial.sql` generated by `bunx drizzle-kit generate --name=initial`, 8 immutability triggers appended by hand (drizzle-kit has no trigger support; migrator re-hashes SQL content so the edit is safe); `bunx drizzle-kit generate` re-run confirms zero schema drift. verify-db compares FK sets order-independently (SQLite returns `PRAGMA foreign_key_list` in reverse declaration order — order is meaningless, set is asserted). `ci` now = typecheck + verify:db. Port 3000 in this workspace is occupied by an unrelated auth-gated service; dev boot tested on `PORT=3100`. |
| 2026-08-13 | 0 — scaffolding | Exit green: `bun run typecheck` passes; `bun run dev` boots (pino log, no `console.*`) and `GET /api/health` → `200` `{"status":"ok","dbTimeMs":…,"ledgerCounts":{}}`. Deps resolved by `bun add`: drizzle-orm 0.45.2, hono 4.13.1, @hono/zod-validator 0.9.0, better-auth 1.6.27, @better-auth/drizzle-adapter 1.6.27, zod 4.4.3, pino 10.3.1, drizzle-kit 0.31.10 (dev). **Docs changed (spec-vs-resolved-version defects, AGENTS.md §4):** architecture.md §4.1 — `withTx` is an async wrapper because the resolved drizzle 0.45.x sync driver returns `T` from `db.transaction` directly (callback stays non-async; invariant T1 intact); §6 — added rows for `drizzle()` construction (`$client` on the intersection type) and pino (`export =` CJS, `esModuleInterop` added to tsconfig; §2 Language row updated). Chrome binary **not** discoverable in this workspace (BUN_CHROME_PATH empty, none on PATH) — not installed per operator instruction; PDF work in phase 9 will exercise the documented missing-renderer non-fatal path. Health stub returns `ledgerCounts: {}` until the fact tables exist; phase 10 wires the real counts. `bun run ci` currently = typecheck; grows per phase per audit.md §2. |
