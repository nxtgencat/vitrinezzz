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


**Exit:** `bun run typecheck` passes on an empty `src/`; `bun run dev` boots and serves
`GET /api/health` → `200`. Commit `phase 0: scaffolding`.

## Phase 1 — Schema & migrations

- [ ] All 38 tables from `schema.md` as Drizzle schema files, one file per domain
      group (`schema.md` §3–§13).
- [ ] Immutability triggers on all four `[FACT]` tables.
- [ ] `drizzle-kit generate` + apply against a fresh file.
- [ ] `scripts/verify-db.ts`.

**Exit:** `verify-db` green (38 tables, WAL, triggers, 0 CHECKs, no REAL, all partial
UNIQUEs). Commit `phase 1: schema`.

## Phase 2 — Auth, RBAC, bootstrap admin

- [ ] Mount `better-auth` (`src/lib/auth.ts`); define its four tables for
      `drizzle-kit`.
- [ ] `databaseHooks.user.create.after` → auto-provision `customers` row.
- [ ] `requireStaff` / `requireCustomer` / `requireCapability` guards
      (`architecture.md` §4.14), null-safe (403, never 500).
- [ ] Bootstrap-admin boot step (`SUPERUSER_*`), idempotent; seed `Admin` role.
- [ ] `scripts/verify-rbac.ts` + RBAC scenario tests (`audit.md` §4).

**Exit:** sign-up creates a customer profile automatically; bootstrap admin exists
after first boot and is undeletable (`409 protected_resource`); a capability-gated call
without the capability returns `403`, never `500`; fresh boot → exactly one
`isProtected` profile. Commit `phase 2: auth`.

## Phase 3 — Idempotency, errors, money, doc numbers

- [ ] `lib/idempotency.ts` (`withIdempotency`), `lib/errors.ts` (envelope, codes,
      `app.onError`/`notFound`), `lib/money.ts` (floor-tax rule), `lib/doc-number.ts`.
- [ ] `Bun.cron` idempotency-key reaper (24h TTL).
- [ ] `scripts/verify-hygiene.ts`, `scripts/verify-deps.ts`,
      `scripts/verify-immutability.ts`.

**Exit:** scenario tests for R1 (replay byte-identical, mismatch → 409, concurrent
same-key single execution) and the crash-mid-transaction test pass; reaper deletes
expired rows on a manual trigger in test; hygiene/deps/immutability checks green.
Commit `phase 3: core`.

## Phase 4 — Catalog, inventory, stock projection, audit wiring begins

- [ ] Catalog CRUD services (`api.md` §3: categories/products/variants) with
      `audit_events` writes on every mutation.
- [ ] Batch creation, `stock_movements` writes, `stock_levels` projection maintenance
      (the one projector, `architecture.md` §4.6).
- [ ] FIFO-by-expiry batch allocation helper (`allocateBatches`), pure, unit-tested
      standalone.
- [ ] `scripts/verify-stock.ts`, `scripts/verify-audit.ts`.
- [ ] `smoke-catalog.ts`.

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
| 2026-08-13 | 0 — scaffolding | Exit green: `bun run typecheck` passes; `bun run dev` boots (pino log, no `console.*`) and `GET /api/health` → `200` `{"status":"ok","dbTimeMs":…,"ledgerCounts":{}}`. Deps resolved by `bun add`: drizzle-orm 0.45.2, hono 4.13.1, @hono/zod-validator 0.9.0, better-auth 1.6.27, @better-auth/drizzle-adapter 1.6.27, zod 4.4.3, pino 10.3.1, drizzle-kit 0.31.10 (dev). **Docs changed (spec-vs-resolved-version defects, AGENTS.md §4):** architecture.md §4.1 — `withTx` is an async wrapper because the resolved drizzle 0.45.x sync driver returns `T` from `db.transaction` directly (callback stays non-async; invariant T1 intact); §6 — added rows for `drizzle()` construction (`$client` on the intersection type) and pino (`export =` CJS, `esModuleInterop` added to tsconfig; §2 Language row updated). Chrome binary **not** discoverable in this workspace (BUN_CHROME_PATH empty, none on PATH) — not installed per operator instruction; PDF work in phase 9 will exercise the documented missing-renderer non-fatal path. Health stub returns `ledgerCounts: {}` until the fact tables exist; phase 10 wires the real counts. `bun run ci` currently = typecheck; grows per phase per audit.md §2. |
