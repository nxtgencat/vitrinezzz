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

- [ ] Transfer draft → confirm (atomic, whole-doc rollback on insufficient stock) →
      void; adjustment create → confirm → void.
- [ ] Media upload/delete (`api.md` §3) with thumbnailing (`Bun.Image`) and
      `audit_events` writes.
- [ ] `smoke-inventory.ts`, `smoke-media.ts`.

**Exit:** 3+ line transfer atomic; insufficient-stock rolls back the whole transfer,
zero movements; re-confirm → 409 zero movements; media upload produces a thumbnail
and an audit row; `verify-stock` still green. Commit `phase 5: inventory`.

## Phase 6 — Purchasing

- [ ] Vendor bill draft CRUD (items + signed charges); `issue` — recompute totals,
      create-or-reuse batches by `(variantId, batchNumber)`, write `purchase`
      movements per line, snapshot totals; void (draft only).
- [ ] Vendor payment recording (shared `recordPayment` service — also used by §9).
- [ ] `smoke-purchasing.ts`.

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
| 2026-08-13 | 4 — catalog | Exit green: `bun run ci` end-to-end (typecheck + verify:db + verify:rbac + test:rbac 12/12 + verify:immutability + verify:hygiene + verify:deps + verify:stock + verify:audit 9 routes + smoke:catalog + test:core 17/17 + test:stock 7/7); boot smoke on `PORT=3107/3108` with `AUTH_SECRET` (health 200 `{"status":"ok"}`, `/api/categories` 200 public). Delivered: `services/catalog.ts` (`slugifyName`; `createCategory`/`updateCategory` — parent 404, walk-up cycle → `409 category_cycle`; `createProduct` — duplicate slug → `409 duplicate_slug` + UNIQUE backstop, creates base variant (`isBase=1`, `isTaxable=1`, `isCustomerVisible=1`) in the same tx, audits product+variant; `updateProduct` — slug immutable; `deactivateProduct` — no audit row when already inactive; `createVariant` — duplicate `sku`/`barcode` → `409 duplicate_sku`, `mrpPaise` defaults to `sellingPricePaise`; `updateVariant` — self-excluding dup checks), `services/stock.ts` (`writeMovement` — the one projector, inserts the fact row + upserts `stock_levels` via increment, `lastMovementId`/`updatedAt` = the movement's own id/createdAt so an `(createdAt,id)` replay is byte-identical; `sumStock`/`sumStockAtBatch` — decision reads, `coalesce(sum(delta),0)` in-tx, never the cache; `allocateBatches` — pure FIFO-by-expiry `(expiryDate ASC, nulls last, batchId tie-break)`, skips `≤0` holdings, `null` when insufficient; `createBatch` — `UNIQUE(variantId,batchNumber)` → `409 duplicate_batch`, audits; `listStockLevels` — display-only join), `routes/catalog.ts` + `routes/inventory.ts` (sub-apps, mounted `app.route("/api", …)` — routePath verified to include the mount prefix so idempotency operations are full paths; `jsonValidator`/`queryValidator`/`paramValidator` in `lib/validate.ts` wrapping `zValidator` with the throwing 400 hook; `paise = z.number().int().min(0)`, `z.uuid()`, `z.coerce.number()` page params, `z.enum(["0","1"])` active filters; GETs public per api.md `*`, stock-levels `S`), `app.ts` (hooks + `/api/auth/*` + `/api/health` + mounts, `export type AppType`; `index.ts` slimmed to migrate+bootstrap+serve+cron), `scripts/verify-stock.ts` (seed via services, replay byte-compare incl. `lastMovementId`/`updatedAt`, empty reads zero rows), `scripts/verify-audit.ts` (route → service file → entityType table, 9 mutations), `scripts/smoke-catalog.ts` (sign-in, public read 200, `S` read 401, missing idempotency key 400, create+replay `Idempotency-Replayed: true`+mismatch 409, cycle 409, duplicate slug/sku/batch 409s, deactivate, zero `stock_levels` on fresh DB and for a stock-less batch, audit rows per entity), `test/stock.test.ts` (7 tests: allocateBatches unit matrix, projector byte-identical replay, R2 manual-adjustment-style race via `test/fixtures/adjust-worker.ts` — two spawned consumers on one unit → exits exactly `{0,3}`, final quantity 0, exactly 2 movements). **Docs changed (spec defects, AGENTS.md §4):** (1) `products.categoryId` — schema.md said NOT NULL but api.md has always marked it optional (`categoryId?`); uncategorized products are legal. Schema made nullable; new migration `0001_products_category_nullable.sql` (drizzle-kit table-rebuild), schema.md §3.2 updated; verify-db unaffected (no nullability assertions). (2) `category_cycle` added to the closed reason vocabulary (lib/errors.ts REASON_CODES + architecture.md §4.13 + api.md §3). (3) Layout — new `routes/` dir + root `app.ts` (architecture.md §4.15 rows for Layout, Route layer, Slugs); verify-hygiene/verify-deps/verify-immutability scan scopes extended (`routes/`, `app.ts`; immutability additionally applies the whole migration set, not just `0000`). (4) verify-hygiene client-origin money allowlist += `costPricePaise`/`sellingPricePaise`/`mrpPaise` (catalog master data is client-originable — architecture.md §4.4 already said so; audit.md §2 row 7 noted). (5) verify-deps deferred list emptied — `zod`/`@hono/zod-validator` now imported at the route boundary (audit.md §2 row 8). (6) R2 in audit.md §4 restated as the manual-adjustment race that actually landed; checkout variant comes with the sales phase. (7) architecture.md §6 += zod v4 `z.uuid()` (deprecation verified in installed types), `z.coerce.number()`, and the validator-wrapper constraint. `ci` grew: verify:stock + verify:audit + smoke:catalog + test:stock. |
| 2026-08-13 | 3 — core | Exit green: `bun run ci` end-to-end (typecheck + verify:db + verify:rbac + test:rbac 12/12 + verify:immutability + verify:hygiene + verify:deps + test:core 17/17); boot smoke on `PORT=3100` with `AUTH_SECRET` set (health 200, unknown route → 404 envelope `{code:NOT_FOUND,reason:not_found}`, sign-up 200); `bunx drizzle-kit generate` → zero schema drift. Delivered: `lib/idempotency.ts` (`withIdempotency` — missing key 400 `idempotency_key_required`, replay byte-for-byte with `Idempotency-Replayed: true`, mismatch 409 `idempotency_mismatch`, hash = sha256(canonicalJson(body??null)+"\n"+actorId), row+work in one `immediate` tx, run callback returns the response body verbatim; `respondIdempotent`; `reapExpiredIdempotencyKeys` — count-then-delete inside `withTx` (bun-sqlite tx `.run()` types as `void`, so no `.changes` read), non-fatal), `lib/errors.ts` (envelope, status→code map, Zod `cause.issues` → `details` duck-typed, unknown errors logged `INTERNAL` 500 never leaked), `lib/money.ts` (floor-tax + line-total), `lib/doc-number.ts` (RFC 4648 base32, 7×5 random bits), `index.ts` (onError/notFound + `Bun.cron("0 3 * * *")` reaper), `db/schema/system.ts` (`responseSnapshot` → plain TEXT, no JSON mode — verbatim bytes; SQL unchanged, zero drift), `scripts/verify-immutability.ts` (scratch-DB UPDATE/DELETE → ABORT on all 4 [FACT] tables + production-dirs grep), `verify-hygiene.ts` (console/any/banned-deps/tsconfig/typecheck/client-origin money scan), `verify-deps.ts` (imports↔declared both directions), `test/core.test.ts` (17 tests: doc-number, money floor, service-level idempotency incl. rollback-together and actor-binding, R1 HTTP envelope incl. concurrent single-execution, reaper manual trigger, crash-mid-transaction via `Bun.spawn` of `test/fixtures/crash-worker.ts` — worker dies at `process.exit(1)` inside the tx callback, verify worker reopens the same file and replays the key cleanly). `ci` = typecheck + verify:db + verify:rbac + test:rbac + verify:immutability + verify:hygiene + verify:deps + test:core. **Docs changed (spec defects/clarifications, AGENTS.md §4):** (1) §4.2 now defines the exact `requestHash` concatenation and the `withIdempotency` contract (operation = `c.req.method + " " + c.req.routePath`; run returns the response body; reaper registered in `index.ts`, never fatal). (2) §4.15 doc-number row: RFC 4648 base32 alphabet + regenerate-on-UNIQUE-violation contract (the spec said only "7 base32 chars"). (3) schema.md §12.1: `responseSnapshot` stored verbatim as plain TEXT (no JSON mode). (4) audit.md §2 rows 3/7/8: scan scopes made explicit (immutability grep = lib/db/scripts + index.ts, tests exempt; hygiene = code dirs + root files, self-file excluded; deps = same dirs + index.ts, with tooling allowlist `typescript`/`@types/bun`/`drizzle-kit` and deferred-import list `@hono/zod-validator`+`zod` → phase 4 route boundaries, must be empty or justified at sign-off). |
| 2026-08-13 | 2 — auth | Exit green: `bun run verify:rbac` PASS, `bun run test:rbac` 12/12, `bun run typecheck` + `verify:db` green, `bun run ci` green; boot smoke on `PORT=3100` (port 3000 is this workspace's other service): `/api/health` 200, sign-up 200, session round-trip 200 with correct email, exactly one `isProtected` profile. Delivered: `lib/auth.ts` (better-auth mount, `ALL_CAPABILITIES`, `isCapability`, idempotent `bootstrapAdmin` — seeds `Admin` role (9 caps, global), default outlet `"Main Outlet"` when none exists, admin user via `auth.api.signUpEmail`, protected profile; audit rows `actorId "system"`, `actorType "system"`; throws when `SUPERUSER_*` set without `AUTH_SECRET`), `services/rbac.ts` (`requireStaff`/`requireCustomer`/`requireCapability`, HTTPException, strict outlet-scope rule), `services/audit.ts` (`writeAuditEvent`), `services/staff.ts` (`deactivateStaffProfile`: 404 `not_found`, 409 `protected_resource`), `index.ts` (mount `/api/auth/*`, boot `await bootstrapAdmin()`), `scripts/verify-rbac.ts`, `test/rbac.test.ts`, `ci` = typecheck + verify:db + verify:rbac + test:rbac. **Docs changed (spec-vs-resolved-version defects, AGENTS.md §4):** (1) drizzle adapter — resolved 1.6.27 throws `BetterAuthError: model "user" was not found` without the schema object; §6 row updated to the real shape (`schema: { user, session, account, verification }`, `transaction: true`), and the adapter declares neither `supportsDates` nor `supportsBooleans`, so raw `Date`/`boolean` would hit bun:sqlite (`Binding expected …` on every create) — auth tables now carry drizzle modes `integer(name, { mode: "timestamp_ms" | "boolean" })` (SQL unchanged: still INTEGER ms / 0-1; `db:generate` confirms zero drift); documented schema.md §13 + §1. (2) `emailAndPassword.enabled` defaults false — §6 row added. (3) better-auth's built-in rate limiter trips under burst sign-ups in scripts/tests (default `3` per `10s` per IP on sign-up/sign-in) — disabled under `NODE_ENV=test`/`TEST=true` (`rateLimit.customRules["*"] = false`, production keeps defaults); §4.14 rate-limiting paragraph rewritten to match reality (the 30/min /api/auth/* figure was stale; specific limits land with their phases). (4) guard contract — guards throw Hono `HTTPException` (envelope is phase 3); strict outlet-scope semantics written into §4.14 (scopedOutletId must equal `actor.outletId` for outlet-scoped roles; unscoped ops denied to outlet-scoped actors; global roles unrestricted). (5) bootstrap now seeds the default outlet `"Main Outlet"` (spec gap — first boot needs one); documented §4.14. (6) layout §4.15 adds `services/` and `test/`. **Scheduling observation:** api.md §2 staff/roles/settings HTTP routes (incl. `POST /api/staff/:id/deactivate`) deliberately NOT built this phase — mutating routes need `withIdempotency` (phase 3); the 403/404/409 deactivation contract is exercised at the service level in verify-rbac + rbac.test. |
| 2026-08-13 | 1 — schema | Exit green: `bun run scripts/verify-db.ts` PASS — 38 tables, exact column order per `schema.md` §3–§13, exact FK set (restrict/cascade per §15), 49 indexes (24 unique incl. all 6 partial UNIQUEs), composite PK `stock_levels(variantId, outletId, batchId)`, `journal_mode = wal`, `foreign_keys = 1`, 0 CHECK constraints, 0 REAL columns, 8 immutability triggers present (4 tables × update/delete). `bun run typecheck` green; `bun run ci` green; fresh-file migration verified (delete `data/vitrine.sqlite` → boot re-creates 38 tables); `bun run dev` boots, `/api/health` → 200. **Docs changed (spec defects, AGENTS.md §4):** (1) layout — docs said `src/lib/*` / `src/db/schema/*` but phase 0 established root `lib/`; fixed schema.md §13, todo.md, audit.md §2, task.md, added Layout row to architecture.md §4.15. (2) FK enforcement — `bun:sqlite` defaults `PRAGMA foreign_keys = 0`, so every FK in schema.md would have been decorative; added boot `PRAGMA foreign_keys = ON` (lib/db.ts) and documented it in architecture.md §4.1 + schema.md §1; verify-db asserts it. (3) `stock_levels.lastMovementId` — clarified no FK (denormalized pointer, like `stock_movements.sourceId`), schema.md §4.1. (4) migrations-at-boot — architecture.md §4.1 now states boot runs `migrate(db, { migrationsFolder })`; §6 rows added for `migrate()` and the sqlite schema builder shapes. Migration: `0000_initial.sql` generated by `bunx drizzle-kit generate --name=initial`, 8 immutability triggers appended by hand (drizzle-kit has no trigger support; migrator re-hashes SQL content so the edit is safe); `bunx drizzle-kit generate` re-run confirms zero schema drift. verify-db compares FK sets order-independently (SQLite returns `PRAGMA foreign_key_list` in reverse declaration order — order is meaningless, set is asserted). `ci` now = typecheck + verify:db. Port 3000 in this workspace is occupied by an unrelated auth-gated service; dev boot tested on `PORT=3100`. |
| 2026-08-13 | 0 — scaffolding | Exit green: `bun run typecheck` passes; `bun run dev` boots (pino log, no `console.*`) and `GET /api/health` → `200` `{"status":"ok","dbTimeMs":…,"ledgerCounts":{}}`. Deps resolved by `bun add`: drizzle-orm 0.45.2, hono 4.13.1, @hono/zod-validator 0.9.0, better-auth 1.6.27, @better-auth/drizzle-adapter 1.6.27, zod 4.4.3, pino 10.3.1, drizzle-kit 0.31.10 (dev). **Docs changed (spec-vs-resolved-version defects, AGENTS.md §4):** architecture.md §4.1 — `withTx` is an async wrapper because the resolved drizzle 0.45.x sync driver returns `T` from `db.transaction` directly (callback stays non-async; invariant T1 intact); §6 — added rows for `drizzle()` construction (`$client` on the intersection type) and pino (`export =` CJS, `esModuleInterop` added to tsconfig; §2 Language row updated). Chrome binary **not** discoverable in this workspace (BUN_CHROME_PATH empty, none on PATH) — not installed per operator instruction; PDF work in phase 9 will exercise the documented missing-renderer non-fatal path. Health stub returns `ledgerCounts: {}` until the fact tables exist; phase 10 wires the real counts. `bun run ci` currently = typecheck; grows per phase per audit.md §2. |
