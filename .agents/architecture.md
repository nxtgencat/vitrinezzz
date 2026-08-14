# Vitrine — Architecture

The design decisions behind `schema.md` and `api.md`. Read this before
either of them.

---

## 1. Principles

1. **Simplicity is a feature.** Every abstraction must justify itself against `task.md`
   §4 or be cut. Proof of the gate applied: 38 tables, one stock projection, one
   idempotency mechanism, one unified payment shape, zero queues, zero reservations.
2. **Correctness by construction, not convention.** What the type system can enforce, it
   enforces (synchronous transaction bodies, §4.1). What the database can enforce, it
   enforces (WAL, UNIQUE, immutability triggers). What's left is grep-gated in
   `bun run ci` — never "trusted."
3. **Never trust the client.** Any value touching money or stock is recomputed
   server-side inside the deciding transaction. The complete client-originable list is
   closed (§4.4).
4. **Snapshots vs. current truth, stated once per entity** (§4.5) — no ambiguity about
   what's frozen at issue time and what's always re-derived.
5. **Everything degrades safely.** PDF failure, gateway downtime, a corrupt backup
   input: logged via pino, never fatal to a sale, never fatal to the process.
6. **One git commit per phase**, in dependency order, none bundling two phases.
7. **Hygiene has zero exemptions** — not in application code, not in scripts, not in
   tests.

---

## 2. Stack — installed via `bun add <pkg>` & verified call shapes

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Bun (engine, floor `^1.3.14` — not a `bun add` package) | `Bun.serve({ fetch })`; port from `$PORT` then `3000`. |
| Database | `bun:sqlite`, one file, WAL at process start | Single writer — every concurrency/idempotency proof in §4 rests on this. |
| ORM | `bun add drizzle-orm` (+ `drizzle-orm/bun-sqlite` subpath) + `bun add -d drizzle-kit` | `db.transaction(fn, { behavior: "immediate" })`; synchronous terminal methods only (`.all()`/`.get()`/`.run()`/`.values()` — **there is no `.sync()`**). Dev: `bun add -d @libsql/client` (0.17.4) — Drizzle Studio cannot drive `bun:sqlite`, so `db:studio` uses `@libsql/client`; drizzle-kit normalizes the `dbCredentials.url` to `file:` automatically. |
| HTTP | `bun add hono @hono/zod-validator` | Exports `AppType = typeof app`; `zValidator` does **not** throw by default — the hook must `throw new HTTPException(400, { cause: result.error })`. |
| Auth | `bun add better-auth @better-auth/drizzle-adapter` (`provider: "sqlite"`) | Mounted `POST/GET /api/auth/*` via `auth.handler(c.req.raw)`; `databaseHooks.user.create.after` auto-provisions a `customers` row. |
| Validation | `bun add zod` at the route boundary only | `z.enum([...])`, not `z.nativeEnum` (doesn't exist in v4); issues at `error.issues`. |
| Logging | `bun add pino`, one `lib/logger.ts` singleton, `.child({ module })` per subsystem | Zero `console.*` anywhere, no exemptions. |
| Language | TypeScript 7.0.2 (`bun add -d typescript` — native Go `tsc`, the only `tsc`; 2026-08-13 upgrade from the 5.9.3 peer dep `bun init -y` supplied) — `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `esModuleInterop` (required to default-import CJS `export =` packages such as pino, §6), `types: ["bun"]` | TS 6/7 defaults: `types` = `[]` (no `@types/*` auto-discovery — `"bun"` listed explicitly), `strict` on, `rootDir` = `./`; hard errors on `baseUrl`, `moduleResolution: node/node10/classic`, `target: es5`, `module: amd/umd/systemjs/none`, `esModuleInterop: false`. TS 7 ships **no programmatic API** (7.1 adds it) — `tsc` CLI only; nothing in this repo imports the `typescript` package. |
| Realtime | Bun native WebSockets, one hub at `/api/ws` | `server.upgrade`, `socket.subscribe(topic)`, `server.publish(topic, msg)` — no broker. |
| PDF | `Bun.WebView({ backend: "chrome", headless: true })` + `view.cdp("Page.printToPDF", …)` | Result object returned **directly** — payload at `result.data`, not nested under a further `{ data }`. |
| Media | `Bun.S3` (optional, MinIO-compatible) or local `STORAGE_DIR`; `Bun.Image` for thumbnails | No image-processing library. |
| Cron | `Bun.cron(pattern, handler)` | **Not** `Bun.cron.schedule({...})` — that shape doesn't exist. |
| Testing | `bun test` + deterministic `scripts/verify-*` / `scripts/smoke-*`, both wired into `bun run ci` | Script-only misses regressions; test-only is slow to audit — both run. |

**How dependencies are added — binding:** every runtime dependency above is installed with
`bun add <pkg>` (dev tools with `bun add -d <pkg>`), which lets Bun resolve the latest
compatible release and records it in `package.json` + `bun.lock`. Nothing is hand-pinned.
Verified call shapes in §6 were checked against the version Bun resolved into
`node_modules`, and must be re-checked whenever a `bun add` re-resolution bumps a major
version.

**Banned in `package.json`** (grep-gated, zero exemptions): `redis`, `ioredis`,
`bullmq`, `puppeteer`, `playwright`, `pdf-lib`, `sharp`, `bcryptjs`, `argon2`,
`node-cron`, `multer`, `uuid`, `dotenv`, `ws`, `archiver`, `tar`, `kysely`,
`@hono/node-server`, any Node-runtime-only package. Every dependency must be imported
somewhere and every import must resolve to a declared dependency (`verify-deps.ts`,
both directions).

**Standing research rule** (binding — full statement in `AGENTS.md` §2): before writing
any call to a library API you're not 100% certain of against the resolved version in
`node_modules`, search the canonical doc first. Never code from memory. §6 records what's
already been checked.

---

## 3. Principles recap → §4 is where they become mechanism

Sections below are the "how" for every commitment in `task.md` §3.

---

## 4. Architecture

### 4.1 Process, concurrency, and the transaction rule

One Bun process hosts everything: the Hono HTTP router, the WebSocket hub, the
`Bun.WebView` PDF printer, and every `Bun.cron` job. One `bun:sqlite` connection,
opened once at boot, is shared by the whole process
through a single Drizzle instance. Boot sequence on the connection, in order:
`PRAGMA journal_mode = WAL` (persisted in the file), `PRAGMA foreign_keys = ON`
(`bun:sqlite` defaults it OFF — without this every FK in `schema.md` is decorative),
then `migrate(db, { migrationsFolder })` from `drizzle-orm/bun-sqlite/migrator`
(§6) — idempotent, applies only pending migrations, so the process always starts
against the schema the code expects. There is no connection pool because there is
exactly one connection — `bun:sqlite` is synchronous and single-writer by nature, so
a pool would add coordination overhead for zero concurrency gain.

**T1 — every mutating operation runs inside `withTx`, whose callback is fully
synchronous — no `await` anywhere inside it, enforced by the type system:**

```ts
// lib/db.ts
export async function withTx<T>(fn: (tx: Tx) => T): Promise<T> {
  return db.transaction((tx) => fn(tx), { behavior: "immediate" });
}
// fn is declared non-async: writing `await` inside a callback is a TS syntax error.
```

Note on the wrapper: on the resolved `drizzle-orm` 0.45.x sync driver,
`db.transaction(...)` returns `T` synchronously (`Result<'sync', T> = T`), so `withTx`
is an `async` function that runs the transaction body synchronously and surfaces the
result as `Promise<T>` for route handlers to `await`. The `fn` callback itself stays
non-async — the invariant below is about the callback, not the wrapper.

Consequences, each of which the rest of this document treats as a proof, not a hope:

- A transaction body executes as one uninterrupted synchronous block:
  `BEGIN IMMEDIATE → work → COMMIT/ROLLBACK` with no suspension point in between. No
  other request's statement can interleave, so `SQLITE_BUSY` cannot occur and deadlock
  cannot occur — both eliminated by construction, not by retry logic. Concurrent
  requests serialize at whole-transaction granularity.
- PDF rendering is an async operation (`await view.navigate(...)` etc.). Because the
  compiler forbids `await` inside `withTx`, it is structurally impossible to print from
  inside a transaction — non-fatal PDF failure (§4.9) is a consequence of this rule,
  not a separate convention that could be forgotten. Realtime publish (§4.8) is a
  *synchronous* `server.publish` — it needs no await, so the compiler does not
  police it; its call sites are restricted to route handlers running after the
  transaction's promise resolves, enforced by `scripts/verify-realtime.ts`.
- pino logging *inside* a callback is fine (synchronous, no I/O await).

**T2 — every transaction takes the write lock up front** (`behavior: "immediate"`).
Every transaction here either writes or gates a write on freshly re-derived state, so
deferred locking buys nothing but lock-upgrade races.

**T3 — fixed statement order** inside any multi-row transaction: (1) idempotency
check/insert (§4.2), (2) fact-table rows (`stock_movements`, `payments`, `order_events`,
`audit_events`), (3) projection update (`stock_levels`), (4) document header state
(status, version, numbers). A fixed order under single-writer serialization means every
transaction's behavior is deterministic regardless of what else is queued behind it.

### 4.2 Idempotency (one mechanism, everywhere)

Every mutating route (marked `I` in `api.md`) requires header `Idempotency-Key`;
missing → `400 VALIDATION`, `reason: idempotency_key_required`. Reads never need it.

`operation` = method + route pattern (e.g. `POST /api/invoices/:id/issue`). Routes
derive it as `${c.req.method} ${c.req.routePath}` (Hono returns the registered
pattern, so the same key on a different route is a different `(operation, key)`
and never collides). `key` = the header value. `requestHash` = SHA-256 of the
canonicalized (sorted-key) request body JSON plus the actor's user id —
defined exactly as `sha256(canonicalJson(body ?? null) + "\n" + actorId)`,
`canonicalJson` being a recursive key-sort producing compact JSON
(`lib/idempotency.ts`). A key reused by a different actor is a mismatch, because
the hash is bound to the actor.

Inside the **same** `immediate` transaction as the work, in this exact order:

1. Read `idempotency_keys` for `(operation, key)`.
2. **Present, hash matches:** return the stored `responseSnapshot` verbatim, header
   `Idempotency-Replayed: true`. Nothing else executes.
3. **Present, hash differs:** `409 CONFLICT`, `reason: idempotency_mismatch` — the
   client reused a key for different work, a client bug.
4. **Absent:** run the operation, then insert the row (`status: "completed"`,
   `responseSnapshot` = the serialized response) in the same transaction.

**The `withIdempotency` contract** (`lib/idempotency.ts`): the route calls
`withIdempotency({ operation, key, actorId, body, run })`; `run(tx)` performs the
work **inside** the same transaction as the check/insert (statement order T3) and
must return the exact response body object — it is serialized once and stored
byte-for-byte, and a replay returns it via `respondIdempotent(c, result)`, which
sets the replay header and sends the stored bytes. The missing-key 400 is thrown
by `withIdempotency` itself, so no route can forget it. A `run` that throws rolls
back work and row together — nothing is ever stored for a failed operation, so a
retry with the same key re-executes cleanly.

Because the transaction is synchronous and single-writer (§4.1), a concurrent duplicate
request's transaction cannot begin until the first has committed or rolled back — it
either finds the row and replays, or it is the one doing the work. **There is no
`processing` state and no TTL-recovery machine**: a crash between `BEGIN` and `COMMIT`
leaves neither a completed row nor completed work, because WAL rollback discards both
together — exactly-once holds across process death with nothing to "repair." Rows are
reaped 24h after `createdAt` by a nightly `Bun.cron` job (`"0 3 * * *"`, registered in
`index.ts`, body = `reapExpiredIdempotencyKeys()` from `lib/idempotency.ts`, which
deletes rows with `expiresAt < now` inside `withTx` and never throws past its own
catch — a failed reap is logged, never fatal).

**Webhooks are the sanctioned exception** — gateways don't send idempotency keys.
`POST /api/webhooks/payments/:gateway` is protected instead by:

1. **HMAC-SHA256 signature verification over the raw request body, before any database
   access.** Failure → `401`, zero DB reads or writes. The secret is
   `WEBHOOK_SECRET_<GATEWAY>` where `<GATEWAY>` is the path param uppercased
   (`lib/webhook.ts`: `webhookSecretFor` reads it at call time; a missing variable
   denies). The signature is `hex(HMAC-SHA256(raw body, secret))` computed with
   `Bun.CryptoHasher("sha256", secret)` (HMAC mode — the secret is the key), compared
   to the `X-Webhook-Signature` header with `crypto.timingSafeEqual` over
   equal-length hex buffers (length mismatch short-circuits to denial). **The money
   amount is never trusted from the payload** — the webhook body is strict
   `{ event: "payment.confirmed", gatewayPaymentId, gatewayEventId }` and the amount
   is derived from the pending checkout row the payment settles (never client-originable,
   §4.4). Unknown `gatewayPaymentId` → 404.
2. **Provider-event dedupe** via partial-unique `payments(gateway, gatewayEventId)`. The
   transaction inserts the payment row; a replayed or racing duplicate hits the
   constraint, the handler catches it (pre-checked first for the common case; the
   `SQLiteError` `UNIQUE` catch on `payments.gateway` is the race-proof backstop),
   responds `200 { status: "replayed" }` with zero further side effects — the gateway
   stops retrying, nothing double-applies.

### 4.3 Named races and their proof

Because of §4.1, every race below reduces to "two callers, one executes first, the
second re-derives inside its own transaction and decides on current truth." Each has a
scenario test in `audit.md` §4.

| # | Race | Resolution |
|---|---|---|
| R1 | Same idempotency key, concurrent requests | Serialize; loser reads and replays the winner's stored row. |
| R2 | Last-unit checkout (two sales of the final unit) | Both serialize; loser re-derives `SUM(stock_movements.delta)` in-tx, sees 0 → `409 insufficient_stock`, whole document rolls back. Stock never negative. |
| R3 | Payment over outstanding balance | Balance recomputed in-tx; over → `409 over_payment`; no partial row survives. |
| R4 | Over-return | Returnable recomputed in-tx from the original line minus prior confirmed returns; over → `409 over_return`. |
| R5 | Concurrent draft edits | Versioned `UPDATE … WHERE id=? AND version=?`; 0 rows → `409 stale_version`. Applies to document drafts only. |
| R6 | Duplicate batch number | `UNIQUE(variantId, batchNumber)`; loser → `409 duplicate_batch`. |
| R7 | Gateway webhook replay/race | Dedupe key hit inside the tx → `200`, zero side effects. |
| R8 | Concurrent sales from the same batch, different outlets | Stock gate re-derives per-outlet sum in-tx — same mechanism as R2. |
| R9 | Concurrent catalog/RBAC edits under audit | `audit_events` insert is append-only and serializes with the rest of the transaction — no new race class introduced. |

**Crash-mid-transaction** is not a separate race: the process dying between `BEGIN` and
`COMMIT` is indistinguishable from the transaction never having happened. WAL recovery
rolls it back; no idempotency row exists; no fact row exists. Tested by killing the
process mid-work and replaying the same key (`audit.md` §4).

### 4.4 Money, rounding, and the client-originable list

All money is INTEGER **paise**. Every money column name ends in `Paise`; **no REAL
column exists anywhere** (`verify-db` + `verify-hygiene` assert this). Tax is INTEGER
percent (`taxRatePct`, `18` = 18% — integer rates only). Quantities are INTEGER —
fractional units are out of scope.

`taxAmountPaise = floor(unitPricePaise × quantity × taxRatePct / 100)` — truncation,
stated once, never banker's rounding, never round-up.

**Discounts, fees, and rounding residuals are one mechanism**: signed `amountPaise`
rows on `invoice_charges` / `bill_charges` (negative = discount). Server enforces
`total = Σ lines + Σ tax + Σ charges ≥ 0` at issue. There is no separate `roundOffPaise`
column — one mechanism beats two for the same concept.

**The complete, closed list of client-originable values** — everything else is
server-computed or server-owned:

| Value | Where | Cap / validation |
|---|---|---|
| Custom line `name`, `quantity`, `unitPricePaise` (+`isCustomItem`) | `invoice_items` | Staff-only; negative price rejected. |
| Charge `name` + signed `amountPaise` | `invoice_charges`, `bill_charges` | `total ≥ 0` enforced at issue. |
| Sale quantities + ids | order/invoice lines | `quantity ≥ 1`; stock gate in-tx. |
| Payment `amountPaise` + `mode` (+gateway refs) | `payments` | ≤ cap, recomputed in-tx (R3); `mode` `gateway` is server-only — webhook amounts are derived from the pending row, never the payload |
| Bill line `unitCostPaise`, `taxRatePct`, `batchNumber?` | `purchase_bill_items` | The vendor's invoice is the world; integer percent validated. |
| Return line `quantity` | `return_items` | ≤ returnable per original line, computed in-tx (R4), never stored. |
| Transfer/adjustment line `quantity` + `batchId` | `stock_transfer_items`, `adjustment_items` | ≤ source stock at the batch, in-tx. |
| Catalog master data (prices, tax rates, names, slugs, batch cost) | reference tables | Client-editable by design — current truth for *future* lines only; never rewrites history. |
| Cart/wishlist `quantity` | `cart_items` | Never trusted at checkout — re-priced and re-gated from scratch (§4.11). |

**Caps, stated once.** All balances sum `payments` rows with `status = 'confirmed'`
**only** — a checkout's `pending` placeholder is insert-only (never deleted, §4.7) and
has moved zero money; counting it would poison every cap it touches. Invoice
outstanding = `Σ(direction='in')` − `Σ(direction='out')` over rows carrying the
invoice's id, where return-linked refunds are included inside those sums with the
document's own id stamped by the service — two refund paths can never jointly exceed
what was paid, because both draw on the same `out` sum. Bill balance owed to a vendor
= `bill.total − Σ payments(direction='out', link=bill)`. Refund caps = `min(paid
balance of the document, remaining return value of the document's confirmed lines)`
(per-return value re-snapshot at confirm, R4). Returnable quantity per original line =
`original quantity − Σ confirmed return lines referencing it`. Every cap violation is
`409 over_payment` (the payment mechanism has one reason; `over_return` is the
quantity-cap reason at return confirm). All recomputed in-tx, never cached.

### 4.5 Data modeling: what is snapshotted, what is recomputed

- **[REF]** mutable master data (catalog, parties, org, batches, roles): stored current
  truth, in-place updates, soft-delete via `isActive`. Reads come straight from these
  tables.
- **[DOC]** header + child line tables: the header carries *state* (status, numbers,
  version); the lines carry *value snapshots frozen at the moment of the money/stock
  decision*. Lines are written once, append-only after their header leaves `draft`.
- **[FACT]** append-only, trigger-protected, insert-only rows (`stock_movements`,
  `payments`, `order_events`, `audit_events`) — the authoritative source for every
  recomputation and every cap.
- **[SNAP]** `stock_levels` — the **only** maintained projection in the system (§4.6).
  If a second projection is ever proposed, it must come with its own replay-verify step
  or be rejected by the simplicity gate.
- **[STAGING]** `cart_items`, `wishlist_items` — disposable customer state, zero events.
- **[SYS]** `idempotency_keys` — routing bookkeeping, reaped.

| Entity | Snapshotted (written once, authoritative forever) | Always recomputed from source |
|---|---|---|
| Invoice line | `name`, `unitPricePaise`, `taxRatePct`, `taxAmountPaise`, `lineTotalPaise`, `allocations` JSON (batch×qty), `isCustomItem` | — |
| Invoice header | `subtotalPaise`, `taxPaise`, `totalPaise` (written at issue) | outstanding/paid balance (from `payments`), returnable per line (from `returns`) |
| Draft invoice | nothing stored — totals computed on read from draft lines | subtotal/tax/total, caps |
| Bill line | `unitCostPaise`, `taxRatePct`, `taxAmountPaise`, `lineTotalPaise`, `batchId` | returnable per line |
| Order | side data only; zero money columns | status timeline from `order_events`; invoice/credit state via links |
| Return line | `unitPricePaise`, `taxAmountPaise` (copied from the original line at confirm) | returnable |
| Payment | amount, direction, link, mode, gateway refs — a fact | caps vs. balance |
| Stock per (variant, outlet, batch) | — | **always** `SUM(stock_movements.delta)`; `stock_levels` is a display cache only |

### 4.6 The one projection and its proof

`stock_levels(variantId, outletId, batchId)` is a maintained cache of
`SUM(stock_movements.delta)` per key. Display reads use it. **Decision reads (gates,
allocations, caps) always re-derive the sum in-transaction** — the projection is
trusted for nothing that spends or prevents spending stock. Correctness is proven by
replay: `scripts/verify-stock.ts` builds a scratch copy, truncates facts + projection,
replays `stock_movements` in `(createdAt, id)` order into the projection, and asserts
the result is byte-identical to the live table and that no quantity is negative. Wired
into `bun run ci` and the nightly cron; a projection bug surfaces as a failed verify,
not a silent oversell.

Why maintain it at all? Storefront/back-office reads (outlet listings, low-stock
filters) hit it constantly; recomputing per read would make the most common read path
quadratic in history. One cache, one prove-it-by-replay rule.

**Batches are global per variant, not per outlet** — an outlet's holding of a batch is
expressed by `stock_levels`, never by the batch row itself. Every `stock_movements` row
references an existing `batchId`; the only entry points that create one are the
explicit batch-create route and purchase-bill-issue (create-or-reuse by
`(variantId, batchNumber)`). Sales allocate FIFO by expiry (`allocateBatches`, a pure,
unit-tested helper): sort `(expiryDate ASC, nulls last, batchId ASC as the
deterministic tie-break)`, greedy take, skip holdings `≤ 0`, return `null` when the
request cannot be fully satisfied (the caller turns that into the in-tx
`409 insufficient_stock`). A return mirrors the exact allocations of the line it
reverses.

### 4.7 Workflows — the document lifecycles, stated once

This is the single source of truth for every status graph. `api.md` routes only
trigger transitions defined here; services reject everything else with
`409 invalid_transition`. **No status graph exists anywhere else.** Corrections are
never edits: an issued document is never edited and never returns to draft. `void`
exists **only** on drafts.

- **Order** — `draft | pending | confirmed | cancelled`. Orders are **header-only**:
  sale lines live on the linked draft invoice, never on the order row. Staff
  (POS/manual): `draft → confirmed` (creates the empty draft invoice; lines then
  enter via `PUT /api/invoices/:id`). Storefront COD: `pending → confirmed` + invoice
  issue in the same transaction. Storefront gateway: `pending → cancelled` (customer)
  — `pending` means payment outstanding; cancelling voids the linked draft invoice.
  Confirmation plays no stock — stock moves at invoice issue.
- **Invoice** — `draft | issued | void (draft only)`. `draft → issue` recomputes money
  from snapshots, allocates and decrements stock, writes `stock_movements` per
  line/batch, snapshots totals, marks `issued` — one transaction, one-shot (re-issue →
  `409 already_issued`). This is the single shared money/stock core (`issueInvoice`)
  behind POS settle, staff issue, storefront COD, and the gateway webhook path.
  Unwinding an issued invoice: sales `returns` (restock) + refund `payments`. A draft
  may supersede another via `supersedesId`.
- **Purchase bill** — `draft | issued | void (draft only)`. `issue` recomputes money
  from item snapshots, creates-or-reuses batches per line, writes in-movements
  (`purchase`), snapshots totals. Unwinding: purchase `returns` (de-stock) + vendor
  refund payments.
- **Stock transfer** — `draft | confirmed | void (draft only)`. `confirm` validates
  every line against source-batch availability in-tx — whole document atomic, one
  insufficient line → `409`, zero movements — writes paired movements
  (`transfer_out`@source = `transfer_in`@destination, same `batchId`). Unwinding: a
  reverse transfer (new document).
- **Adjustment** — `draft | confirmed | void (draft only)`. `confirm` writes signed
  `stock_movements` (`adjustment_in`/`adjustment_out`) per line against explicit
  batches. Unwinding: the opposite adjustment.
- **Return** — `draft | confirmed | void (draft only)`. Two types: `sales` (links an
  order/invoice) and `purchase` (links a bill) — exactly one, matching `returnType`,
  XOR enforced in the service layer. `confirm` validates caps (R4), mirrors the
  original allocations on restock (sales) or de-stocks the bill's batch (purchase).
  Terminal — a wrong return is followed by another return/adjustment, never edited.
- **Shipment** — `created | dispatched | delivered`. Whole-invoice, no line
  quantities. Carrier/AWB editable (versioned) while `created`. One invoice may have
  many shipments; shipment status never changes invoice/order state.
- **Payment** — `pending (gateway only) | confirmed`. Facts: never updated, never
  deleted, never flipped back. Reversals are opposite-direction rows. The `pending`
  row written at gateway checkout stays `pending` forever (insert-only by trigger);
  the phase-8 webhook inserts a separate `confirmed` row carrying `gateway` +
  `gatewayEventId`, deduped on `UNIQUE(gateway, gatewayEventId)`. A webhook arriving
  after the customer cancelled the pending order still records the payment fact
  (`confirmed` row) and immediately compensates: a full auto-refund `out` row +
  `payment.confirmed` + `payment.refunded` events — the money is never lost and never
  double-paid.
- **Media asset** — no lifecycle beyond upload/delete; delete is a hard delete (not a
  document, not trigger-protected) but writes an `audit_events` row.
- **Cart/wishlist line** — no lifecycle; upserted/deleted freely, zero events.

**Storefront sale end-to-end** (stated once): **COD** = order `pending → confirmed` +
invoice `draft → issued` + stock decrement in one tx; payment recorded at delivery as a
plain payment. **Gateway** = order `pending` + payment `pending` + a stock **pre-gate**
at checkout (fail fast if already short); webhook success → payment `confirmed` → order
confirm + invoice issue (the final gate re-runs in-tx; if stock is short despite the
pre-gate, the order auto-cancels and the payment auto-refunds with an `out` row — an
explicit, tested compensation path, not a silent failure, recorded in `order_events`).
Webhook failure/timeout leaves the order `pending` and customer-cancellable; a
webhook that then arrives for the cancelled order records the payment and
auto-refunds it in full (payment workflow above). Cart clearing happens only on a
`confirmed` (or `refunded`) outcome — a `replayed` webhook changes nothing.

### 4.8 Realtime

One hub at `/api/ws`, Bun native WebSockets, upgrade requires a valid staff or customer
session. Three topics: `order:{id}` (its own customer or any staff) ·
`invoice:{id}` (its own customer or any staff) · `stock:{outletId}` (any staff).

**Publish-after-commit is structural, not a convention to remember.** Service
functions never call the publish function themselves — they return the committed
response body, and the idempotency wrapper returns it as `IdempotencyResult.value`
(§4.2). The route handler, running outside `withTx` after the transaction's promise
resolves, derives its publish facts from that committed response and calls
`realtime.publish` — **once per fresh execution, never on a replay**: a replayed
response (`result.replayed === true`) is the durable proof the side effects already
ran (and already published) on the original execution, so the handler publishes
nothing. Because `withTx` callbacks are non-async (§4.1), a PDF render or external
fetch inside a transaction body is a compile error, and a stray `publish` call
inside one is caught by `scripts/verify-realtime.ts` — it is structurally
impossible for a subscriber to observe an event from a transaction that later
rolls back.

**Per-route publish set** (every `‡`-marked row in `api.md`, `‡` = "publishes a
topic after commit"; `scripts/verify-realtime.ts` asserts the register-and-publish
pair bidirectionally):

| Route | Facts published after commit (fresh execution only) |
|---|---|
| `POST /api/inventory/transfers/:id/confirm` | `stock:{fromOutletId}` + `stock:{toOutletId}`, type `stock.changed` |
| `POST /api/inventory/adjustments/:id/confirm` | `stock:{outletId}`, `stock.changed` |
| `POST /api/purchase-bills/:id/issue` | `stock:{outletId}`, `stock.changed` |
| `POST /api/orders/:id/confirm` | `order:{id}`, `order.confirmed` |
| `POST /api/orders/:id/cancel` | `order:{id}`, `order.cancelled` |
| `POST /api/invoices/:id/issue` | `invoice:{id}` `invoice.issued` + `order:{orderId}` `invoice.issued` + `stock:{outletId}` `stock.changed` |
| `POST /api/sales/pos/checkout` | `order:{id}` `order.confirmed` + `invoice:{id}` `invoice.issued` + `stock:{outletId}` `stock.changed` |
| `POST /api/returns/:id/confirm` | `order:{orderId}` `return.confirmed` (only when the return carries an `orderId`) + `stock:{outletId}` `stock.changed` |
| `POST /api/shipments/:id/dispatch` | `order:{orderId}` `shipment.dispatched` (order id read post-commit from the invoice) |
| `POST /api/shipments/:id/deliver` | `order:{orderId}` `shipment.delivered` |
| `POST /api/storefront/checkout` | `order:{id}` `order.confirmed` + `invoice:{id}` `invoice.issued` + `stock:{outletId}` `stock.changed` when the checkout confirmed; else `order:{id}` `order.created` (gateway path leaves the order `pending`) |
| `POST /api/storefront/orders/:id/cancel` | `order:{id}`, `order.cancelled` |
| `POST /api/webhooks/payments/:gateway` | confirmed: `order:{orderId}` `payment.confirmed` + `invoice:{invoiceId}` `invoice.issued` + `stock:{outletId}` `stock.changed`; refunded: `order:{orderId}` `payment.refunded`; `replayed`: nothing (no idempotency header, dedupe instead — §4.7) |

**Payloads are intentionally thin**: `{ type, entityId, at }`, never the full entity. A
client treats any event as "refetch this entity." **Reconnect/resync**: on `open`, the
client re-subscribes and refetches whatever it has displayed. The server keeps no
replay buffer — a publish missed during a disconnected window is recovered by the
client's own refetch, which is why the payload never needs to carry more than an id.

### 4.9 PDF rendering (in-process, client-supplied HTML)

The backend **never composes invoice HTML**. The client (admin app) builds the full
invoice markup and posts it to `POST /api/invoices/:id/render-pdf`, body `{ html }`
(≤256KB, validated before anything else runs). Flow (`lib/pdf.ts`):

```ts
const view = new Bun.WebView({ backend: "chrome", headless: true });
await view.navigate("data:text/html;charset=utf-8," + encodeURIComponent(html));
const result = await view.cdp("Page.printToPDF", {
  printBackground: true, format: "A4", preferCSSPageSize: true,
});
await Bun.write(pdfPath, Buffer.from(result.data, "base64")); // result is direct, not { data }
await view.close();
```

The invoice's `pdfPath` is set in a small, separate transaction after the file write
succeeds — printing is never inside the transaction that issued the invoice, because an
invoice must exist regardless of whether a browser is available to render it. Files
land at `<STORAGE_DIR>/pdfs/<invoiceId>-<uuid>.pdf`; the route responds
`{ pdfPath: string | null }`.

**Non-fatal by design.** A missing Chrome binary, a failed navigate, or a failed print
is caught, logged at `warn` via pino, and leaves `pdfPath` null — the parent request
never fails because of a printing problem, and the route is safely re-callable to
retry. One print runs at a time through a small in-process queue; volume is
per-invoice, human-scale, never a hot path. **Chrome backend is mandatory** — the
WebKit backend has no CDP bridge and cannot print.

### 4.10 Media

Single `media` table, polymorphic owner (`product` | `variant`). Upload: staff with
`canManageCatalog` posts a multipart file (`{ file, altText? }`); the handler
validates size (≤8MB), writes the original via the storage adapter, generates a WebP
thumbnail with `Bun.Image` (`§6`), writes the thumbnail, then inserts the `media` row
and an `audit_events` row in **one transaction**. Delete follows the same pattern.

**The effective MIME type is derived from the filename extension** (`jpg`/`jpeg`/
`png`/`webp`), not from any declared part Content-Type: Bun's multipart parser infers
`File.type` from the extension and ignores the declared header. The extension gate is
therefore the real MIME gate; a corrupt-but-valid-MIME upload still fails at thumbnail
decode with `400 image decode failed` (a client bug, not a 500).

**Serving**: `GET /api/media/:id` is the only way to fetch stored bytes — it streams
the original with `content-type: mimeType`, `404` if the row or the underlying file is
gone (rows survive owner deactivation — no cascade).

**Idempotency + file lifecycle**: file writes are async I/O, so they happen **outside**
the transaction (`§4.1`). The route writes both files, then runs `withIdempotency`
whose body hash binds the file's **sha256** — same key with different bytes →
`409 idempotency_mismatch`. On replay or rollback the just-written files are removed;
delete runs the tx first and removes the stored files only when not replayed.

**Storage adapter**: `Bun.S3` when `S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/
`S3_SECRET_ACCESS_KEY`/`S3_BUCKET` are set (MinIO-compatible); local `STORAGE_DIR`
otherwise. Same `put`/`get`/`delete` interface either way — the choice is a boot-time
environment check, not a code branch anywhere else. No versioning, no albums, no CDN
abstraction — one file, one thumbnail, one row.

### 4.11 Cart & wishlist persistence

`cart_items` / `wishlist_items`, `UNIQUE(customerId, variantId)` each, keyed by
`customerId` so they persist across sessions and devices. **Zero fact-table rows, zero
realtime publish** — adding, changing, or removing a line is plain CRUD.

**The "never trust the client" rule is preserved exactly at checkout.**
`POST /api/storefront/checkout`:

1. Re-reads the customer's `cart_items` inside the checkout transaction.
2. Re-prices every line from current `variants.sellingPricePaise` / `taxRatePct` —
   never from any value stored on the cart row.
3. Re-derives available stock by summing `stock_movements.delta` in-transaction, exactly
   as every other stock gate in this system (§4.6) — a variant that went out of stock or
   changed price since the cart was last touched is caught here, not assumed away.
4. On success: creates the order, allocates and decrements stock, issues the invoice,
   clears the cart — all in one transaction.
5. On any gate failure: the whole transaction rolls back, the cart is **untouched**, and
   the response carries the specific `reason` so the client can show which line failed.

**Outlet resolution.** The storefront operates on one outlet:
`settings.defaultOutletId` when set, else the first active outlet (deterministic:
`createdAt`, then `id`). No outlet at all → 500 `no outlet configured` — a
boot/config defect, not a 404.

**Gateway mode.** `paymentMode = 'gateway'` pre-gates every line (`sumStock ≥ qty`)
but allocates nothing: the order stays `pending`, the invoice stays `draft`, and a
`pending` `payments` row is inserted (`mode=gateway`, `gatewayPaymentId` =
server-generated checkout reference returned to the client as `checkoutReference`).
The cart is **kept** — it is cleared only when the phase-8 payment-confirming
webhook runs the confirm+issue path. A `pending` row is never updated (payments is
insert-only, §4.7); the webhook's `confirmed` row is a new insert, deduped on
`UNIQUE(gateway, gatewayEventId)`.

No abandoned-cart cleanup exists — out of scope by `task.md` §4.

### 4.12 Audit trail

**Why a fourth fact table, not a return to A1's single ledger.** `stock_movements`,
`payments`, and `order_events` each answer one query shape well and need replay/timeline
semantics. Catalog, RBAC, staff, and settings changes need neither — they need "what
changed on this entity, by whom, when," answerable with a flat `before`/`after` diff
row. Funneling everything through one version-chained, correlation/causation-graphed
ledger pays that bookkeeping cost on every write, for a benefit only the stock/order
domains actually use. Cutting the audit trail entirely (as one prior draft did) is the
opposite mistake — it leaves zero compliance answer for "who changed this product's
price." The fix: keep three purpose-built fact tables, add one lean fourth.

**Shape**: `(entityType, entityId, action, actorId, actorType, before, after,
createdAt)` — flat, no version chain, no causation graph.

**Trigger points.** Every service function that creates, updates, or deactivates a row
in `categories`, `products`, `variants`, `batches`, `vendors`, `outlets`, `roles`,
`staff_profiles`, `settings`, or `media` writes one `audit_events` row in the same
transaction as the mutation, before returning. Not opt-in per route — part of the write
path for those domains, enforced by `verify-audit` (`audit.md` §2), which
cross-references every mutating route on an audited domain against a matching
`audit_events` write in its service function. (`vendors` joined the list with the
purchasing phase — a vendor record is reference data like any catalog row, and the
compliance question is the same; `customers` stay out because they are auto-provisioned
by the auth hook, never mutated by a staff route.)

**What does not write here.** `stock_movements`, `payments`, and `order_events` keep
their own tables and triggers. Cart/wishlist writes never produce an audit row — they
are not mutations of reference data.

**Retention.** Never deleted or expired by any job — it is the compliance record, and
reference-data change volume is low enough that unbounded retention is not a storage
concern at this scale. If retention policy changes, that is a new, explicit job.

**Access.** `GET /api/audit`, `canManageStaff` only, filterable by `entityType`,
`entityId`, `actorId`, and a date range.

### 4.13 API ergonomics

Base path `/api`, JSON in/out, `camelCase`. Lists: `{ data: [...], pagination: { page,
pageSize, total, totalPages } }`, `page` 1-based, `pageSize` default 25 max 100,
deterministic order `(createdAt DESC, id DESC)`. Detail: `GET /api/<resource>/:id`.
Mutations: `POST` (create), `PUT` (edit — drafts only for documents),
`POST /:id/<transition>` (`confirm`/`issue`/`void`/`cancel`/`dispatch`/`deliver`/
`render-pdf`) — every transition its own route, every mutation idempotency-keyed.

**Error envelope**, every non-2xx:

```json
{ "error": { "code": "VALIDATION|UNAUTHORIZED|FORBIDDEN|NOT_FOUND|CONFLICT|RATE_LIMITED|INTERNAL", "message": "…", "reason": "…", "details": [] } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION` | 400 | Zod validation failed, or a required header is missing. `details` carries the Zod issue list. |
| `UNAUTHORIZED` | 401 | No valid session, or webhook signature failed. |
| `FORBIDDEN` | 403 | Session valid, capability or profile check failed. |
| `NOT_FOUND` | 404 | Resource doesn't exist or isn't visible to this actor. |
| `CONFLICT` | 409 | Idempotency mismatch, stale version, invalid transition, insufficient stock, over-payment, over-return, duplicate batch, protected resource. |
| `RATE_LIMITED` | 429 | Fixed-window limiter tripped. |
| `INTERNAL` | 500 | Unexpected error — never used for a condition named above; every named failure maps to a code above it. |

Closed `reason` vocabulary — every value has a matching route and a matching test:
`idempotency_key_required` · `idempotency_mismatch` · `insufficient_stock` ·
`over_payment` · `over_return` · `stale_version` · `already_issued` ·
`invalid_transition` · `duplicate_batch` · `duplicate_sku` · `duplicate_slug` ·
`category_cycle` · `protected_resource` · `rate_limited` · `not_found` ·
`bad_signature` · `gateway_unknown`.

**Route manifest checked both directions** by `verify-routes.ts` — nothing in `api.md`
unimplemented, nothing implemented undocumented.

### 4.14 Security & RBAC

**Capabilities — closed set of 9**, stored as a JSON array on `roles.capabilities`:
`canManageCatalog` · `canManageInventory` · `canManagePurchases` · `canManageSales` ·
`canManagePayments` · `canManageReturns` · `canManageFulfillment` · `canManageStaff` ·
`canManageStorefront`. `roles.scope` = `global` | `outlet`; an outlet-scoped role's
effective reach is the staff member's `staff_profiles.outletId`.

**Enforcement point: the service layer, never the route.**
`requireCapability(actor, cap, scopedOutletId?)` is asserted at the top of every gated
service function — unbypassable from a direct call, a cron handler, or a future
internal caller:

```ts
export function createProduct(tx: Tx, actor: StaffActor, input: CreateProductInput) {
  requireCapability(actor, "canManageCatalog");
  const product = insertProduct(tx, input);
  writeAuditEvent(tx, { entityType: "product", entityId: product.id, action: "created",
    actorId: actor.userId, actorType: "staff", before: null, after: product });
  return product;
}
```

**Outlet scope is strict and closed.** `scopedOutletId` declares which outlet the
operation touches. An outlet-scoped role's effective reach is exactly one outlet —
its holder's `staff_profiles.outletId` — so `scopedOutletId` must equal
`actor.outletId`, and operations that declare no scope are denied to outlet-scoped
actors entirely (`403 outside outlet scope`). Global roles (e.g. `Admin`) are
unrestricted by outlet: their capability is global by definition. The check is:

```ts
if (!actor.capabilities.includes(cap)) throw 403 missing capability;
if (actor.roleScope === "outlet" && scopedOutletId !== actor.outletId) throw 403 outside outlet scope;
```

Cron and webhook paths are the zero-capability case **by design**: cron only reads,
verifies, or deletes expired rows; the webhook's only power is the payment-confirm
routine it owns, gated first by signature verification — no staff actor exists in that
request at all.

**Guards throw Hono `HTTPException`** (`hono/http-exception`); the error envelope
(`lib/errors.ts`) arrives in phase 3, until then handlers surface `status` + `message`
directly. `requireStaff` (no session → `401 unauthorized`; session but no/inactive
`staff_profiles` row → `403 not a staff member`; missing role → `403 no role assigned`;
outlet-scoped role whose `outletId` ≠ profile's → `403 role outlet mismatch` — always
`403`, never `500`, an authenticated user without a staff profile is a normal state, a
customer, not a server error), `requireCustomer` (no session → `401`; no/inactive
`customers` row → `403 not a customer` — auto-provisioned via the better-auth
`databaseHooks.user.create.after` hook, which runs **after** better-auth's sign-up
transaction commits, so the profile always exists by the time any customer route runs
and the hook may call `withTx` safely, §6).

**Bootstrap admin** (`lib/auth.ts`, idempotent — runs every boot, acts once):
seeds the global `Admin` role (all nine capabilities) when one doesn't exist; seeds a
default outlet named `"Main Outlet"` when none exists (the first boot always needs
one); then creates the admin user from `SUPERUSER_EMAIL`/`SUPERUSER_PASSWORD` via
`auth.api.signUpEmail` with `staff_profiles.isProtected = true`.
`SUPERUSER_*` set without `AUTH_SECRET` → boot throws. Bootstrap writes are audit-logged
with `actorId: "system"`, `actorType: "system"`. Deactivate/delete of a protected
profile → `409 protected_resource`; unknown profile id → `404 not_found` (deactivation
contract in `services/staff.ts`).

**Rate limiting**: better-auth's built-in fixed-window in-memory limiter, per IP —
defaults: sign-up/sign-in/change-password/change-email `3` per `10s`, password-reset
and email-verification paths `3` per `60s`, everything else `100`/`60s`. Over →
`429`. A single process means a single in-memory map is sufficient; no external cache
needed. Disabled under `NODE_ENV=test`/`TEST=true` (`rateLimit.customRules["*"] = false`)
so verify scripts and test suites can burst sign-ups; production keeps defaults.
Phase-10 specific limits (`/api/storefront/checkout` 5/min) land with their phases.

### 4.15 Conventions

| Rule | Convention |
|---|---|
| Layout | Root-level dirs only — `lib/` (infrastructure: db, logger, idempotency, errors, money, doc-number, pdf, backup, stock-check, auth), `db/schema/` (one Drizzle schema file per `schema.md` domain group §3–§13), `db/migrations/` (drizzle-kit SQL), `services/` (one module per domain service — `rbac.ts`, `staff.ts`, `org.ts`, `audit.ts`, `catalog.ts`, `stock.ts`, …; every gated service asserts `requireCapability` itself), `routes/` (one Hono sub-app module per `api.md` section — `catalog.ts`, `org.ts`, `audit.ts`, `inventory.ts`, …; mounted on the root app as `app.route("/api", xRoutes)`), `app.ts` (the assembled Hono app: hooks, `/api/auth/*` + `/api/health`, sub-app mounts, `export type AppType`; `index.ts` only boots it: `applyMigrations` + `bootstrapAdmin` + `Bun.serve` + crons), `scripts/` (verify-*/smoke-*), `test/` (bun test scenario suites, one `test:<phase>` script per phase). No `src/` wrapper; docs that said `src/` were corrected in phase 1. |
| Route layer | Sub-apps only route, validate, and authorize (route-level `requireStaff`/`requireCapability` mirroring the service assertion); all decision logic, audit writes, and stock writes live in services. Every mutation runs `withIdempotency` + `respondIdempotent`; read guards match the `api.md` column (`*` = public, `S` = staff session, `R(cap)` = staff + capability). |
| Slugs | Server-derived from `name` by `slugifyName` (lowercase, non-alphanumeric runs → `-`, trimmed); collision → `409 duplicate_slug`; immutable after creation. |
| Primary key | `id` TEXT = full `Bun.randomUUIDv7()`, never truncated (time-ordered; truncation collides within a time bucket). `settings` is the singleton exception, fixed id `'singleton'`. |
| Human document numbers | `<PREFIX>-<7 base32 chars>` via `lib/doc-number.ts`, own UNIQUE column, never derived from `id`. The alphabet is **RFC 4648 base32** (`A–Z`, `2–7`), 35 random bits per number. A caller that hits a UNIQUE violation (collision probability ~0.14% at 10k documents) regenerates. Prefixes: `OR` orders, `INV` invoices, `BL` bills, `TR` transfers, `AJ` adjustments, `RT` returns, `SH` shipments, `PY` payments. |
| Money | INTEGER paise; every money column ends in `Paise`. No REAL column anywhere. |
| Tax | `taxRatePct` INTEGER percent. |
| Quantities | `quantity`/`delta` INTEGER, signed where noted. No fractional units. |
| Timestamps | INTEGER unix-ms UTC. `createdAt` everywhere; `updatedAt` on mutable tables only. Set by code, never the client. |
| Booleans | INTEGER 0/1, `is…`/`has…`. |
| Enums | TEXT + Zod union at the boundary. **Zero SQL CHECK constraints, ever.** |
| FKs | `<entity>Id`. `ON DELETE RESTRICT` everywhere except the CASCADE list (`schema.md` §8). Nothing outside it is ever hard-deleted — references deactivate, documents void. |
| Naming | Tables `snake_case` plural, columns `snake_case` — except the four better-auth tables, which keep better-auth's exact camelCase names, zero remapping (the adapter is handed the schema object directly, `schema.md` §13). |
| Column order | Fixed per table: `id` → business columns → status/version → timestamps. `verify-db` asserts it. |

**Immutability triggers**: `BEFORE UPDATE`/`BEFORE DELETE` raising `ABORT` on every
`[FACT]` table (`stock_movements`, `payments`, `order_events`, `audit_events`). Created
once, in the initial migration. Corrections are new rows, never edits.

### 4.16 Env vars

`DATABASE_PATH` (default `./data/vitrine.sqlite`) · `BACKUP_DIR` (default
`./data/backups`) · `AUTH_SECRET` · `SUPERUSER_EMAIL` · `SUPERUSER_PASSWORD` ·
`WEBHOOK_SECRET_<GATEWAY>` (per gateway) · `STORAGE_DIR` (default `./data/storage`,
covers PDFs + local media fallback) · `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` /
`S3_SECRET_ACCESS_KEY` / `S3_BUCKET` (optional, MinIO-compatible, media only) ·
`ALLOWED_ORIGINS` (comma-separated, CORS credentials mode) · `BUN_CHROME_PATH`
(optional PDF pin, falls back to PATH) · `PORT` (default `3000`) · `NODE_ENV`. Anything
that varies per-organization rather than per-deployment (org name, currency, timezone)
lives in the `settings` table, not an env var.

### 4.17 Deployment topology

```
                         ┌──────────────────────────────┐
                         │        Bun process (×1)       │
HTTPS ────────────────▶│  Hono router  /api/*           │
                         │       │                        │
                         │       ├─ services/*.ts          │
                         │       │      │                  │
                         │       │      ▼                  │
                         │       │  withTx(fn) ────────────┼──▶ bun:sqlite (WAL, one file)
                         │       │                        │        vitrine.sqlite(-wal/-shm)
                         │       ├─ WS hub    /api/ws       │
                         │       ├─ Bun.WebView (PDF print) │
                         │       └─ Bun.cron                │
                         │            ├─ nightly backup     │
                         │            ├─ nightly verify-stock│
                         │            └─ idempotency reaper  │
                         └───────────────┬────────────────┘
                                         │ optional, media only
                                         ▼
                          MinIO / S3-compatible bucket
```

**Single-instance scope, stated once**: this system runs as exactly one process against
exactly one SQLite file. No multi-instance mode, no read replica, no distributed lock,
no shared-nothing horizontal scaling path. The single-writer transaction model in §4.1
is what makes every correctness guarantee in this document provable; running two
instances against the same file would break every one of them. If load ever requires
more than one process can serve, that is a different system, not a configuration of
this one.

### 4.18 Nightly backup

`lib/backup.ts` exposes the two callables; `index.ts` registers the cron, mirroring
the idempotency reaper (§4.2) — the same pattern for all three crons in §4.17:

```ts
// index.ts
Bun.cron("0 3 * * *", () => { void runNightlyBackup(); });
```

```ts
// lib/backup.ts
export async function runNightlyBackup(): Promise<string | null> {
  // reads DATABASE_PATH + BACKUP_DIR at call time (BACKUP_DIR defaults to ./data/backups)
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyIfExists(`${DATABASE_PATH}`, `${BACKUP_DIR}/vitrine-${stamp}.sqlite`);
    await copyIfExists(`${DATABASE_PATH}-wal`, `${BACKUP_DIR}/vitrine-${stamp}.sqlite-wal`);
    await copyIfExists(`${DATABASE_PATH}-shm`, `${BACKUP_DIR}/vitrine-${stamp}.sqlite-shm`);
    await pruneBackupsOlderThan(30, "days");
    return main;
  } catch (err) {
    logger.error({ err }, "nightly backup failed");
    return null; // never throws past this point — a failed backup must not affect the running process
  }
}
```

WAL mode means a file-level copy taken outside a write transaction is safe to read
back (the main file plus `-wal`/`-shm` together are a consistent snapshot at copy time;
the job copies all three). Backups older than 30 days are pruned on the same run.
Restore procedure and retention policy: `audit.md` §6.

---

## 5. Explicit non-goals (inside the simplicity gate)

Reservation-at-checkout stock modeling (would require reservation rows, expiry, and
release paths — the single-writer immediate-lock transaction already makes the final
gate at invoice issue atomic and provable, R2; the one gap, an online order that can't
be issued after payment, has an explicit auto-cancel+refund path, §4.7). A second
projection of any kind. A generic EAV attribute engine. Double-entry accounting.
Multi-tenant. Multi-instance scaling. A `currentStock` cached column outside
`stock_levels`. A separate general-purpose event bus. Versioned API. Optimistic
concurrency outside document drafts.

---

## 6. Verified library calls

See `AGENTS.md` §2 for the standing rule this table exists to satisfy. Every call below
was checked against the resolved version's current documentation before use, and must be
re-checked before any `bun add` re-resolution in §2 changes it.

| Call | Exact shape used | Note |
|---|---|---|
| `bun:sqlite` connection | `new Database(path)`; `db.run("PRAGMA journal_mode = WAL;")` at boot | One `Database` = one connection, no pooling. |
| Drizzle transaction | `db.transaction((tx) => fn(tx), { behavior: "immediate" })` | Issues `BEGIN IMMEDIATE`; on the resolved 0.45.x sync driver it returns `T` directly — `withTx` is the async wrapper that routes `await` (§4.1). No `.sync()` variant exists. |
| Drizzle bun-sqlite construction | `drizzle(sqlite)` from `drizzle-orm/bun-sqlite` | Returns `BunSQLiteDatabase & { $client: TClient }` — `$client` is the raw `bun:sqlite` `Database`; annotating the variable with the bare `BunSQLiteDatabase` type drops `$client`, so the inferred type must be kept. |
| Drizzle migrations | `migrate(db, { migrationsFolder })` from `drizzle-orm/bun-sqlite/migrator` | Synchronous, idempotent; tracks applied migrations in `__drizzle_migrations` by `folderMillis` from `meta/_journal.json`, applies the rest inside one transaction. Runs at boot (§4.1) and inside `verify-db`. |
| Drizzle sqlite schema | `sqliteTable(name, { columns }, (t) => [...])` from `drizzle-orm/sqlite-core` | Third arg is an array of `index`/`uniqueIndex`/`primaryKey`/`foreignKey` builders; `text(..., { mode: "json" })` + `$type<T>()` for JSON columns; `references(() => col, { onDelete: "restrict" | "cascade" })` for FKs. Partial unique: `uniqueIndex(n).on(cols).where(sql`…`)`. |
| pino singleton | `import pino from "pino"`; `const logger = pino()` | Resolved 10.x is CJS (`export = pino`) — default import requires `esModuleInterop` (set in tsconfig, §2). `.child({ module })` per subsystem. |
| Hono app export | `export type AppType = typeof app` | Consumed by `hc<AppType>()` on both frontends. |
| `zValidator` error hook | `zValidator("json", schema, (result, c) => { if (!result.success) throw new HTTPException(400, { cause: result.error }); })` | Does **not** throw by default — the hook must throw explicitly, or invalid input silently 200s. Issues at `err.cause.issues`. |
| better-auth adapter | `drizzleAdapter(db, { provider: "sqlite", transaction: true, schema: { user, session, account, verification } })` | Resolved 1.6.27 **requires the schema object** (`config.schema || db._.fullSchema`, else `BetterAuthError: model "user" was not found`). Schema keys are the model names; column names stay better-auth's camelCase — zero remapping. `transaction: true` wraps sign-up in a real transaction (the factory always provides a `transaction` method, falling back to `createAsIsTransaction`). **Pitfall:** the adapter declares neither `supportsDates` nor `supportsBooleans`, so raw `Date`/`boolean` values reach the driver — the auth tables' time/boolean INTEGERs must carry drizzle modes (`mode: "timestamp_ms"` / `mode: "boolean"`, `schema.md` §13), otherwise bun:sqlite throws `Binding expected …` on every user create. |
| better-auth email/password | `emailAndPassword: { enabled: true }` | `enabled` defaults to **false** — sign-up/sign-in endpoints 404 without it. |
| better-auth sign-up | `await auth.api.signUpEmail({ body: { name, email, password } })` → `{ token, user }` | No headers required; email normalized to lowercase, `emailVerified: false`; duplicate email → 422. |
| better-auth session read | `await auth.api.getSession({ headers })` → `{ session, user } \| null` | `requireHeaders: true`; call from route middleware with the request headers. |
| better-auth handler | `app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw))` | Returns a `Response`; mounted once in `index.ts`. |
| better-auth provisioning hook | `databaseHooks.user.create.after: async (createdUser) => …` | Fires **after** the sign-up transaction commits (`queueAfterTransactionHook`) — calling `withTx` inside the hook is safe, no nesting. Used to insert the linked `customers` row. |
| better-auth rate limit | `rateLimit: { customRules: { "*": false } }` | Disables the built-in limiter entirely; applied only under `NODE_ENV=test`/`TEST=true` (`§4.14`). Defaults otherwise: sign-up/sign-in `3`/`10s` per IP, in-memory. |
| Hono guards | `throw new HTTPException(status, { message })` from `hono/http-exception` | Status + message; error envelope lands in phase 3. |
| Zod v4 enums | `z.enum([...])` | `z.nativeEnum` doesn't exist in v4; issues at `error.issues`. |
| Zod v4 UUIDs | `z.uuid()` | `z.string().uuid()` is deprecated in v4 (classic API; default export). |
| Zod v4 query params | `z.coerce.number().int().min(1)` + `z.enum(["0", "1"])` | `z.coerce` string-coerces URL query params; booleans stay string enums at the boundary. |
| Validator wrapper | `jsonValidator`/`queryValidator`/`paramValidator` in `lib/validate.ts` | Constraint `T extends z.ZodType` is assignable to `zValidator`'s `T extends ZodSchema` (`ZodSchema = v3.ZodType \| v4.$ZodType`); the hook always throws `HTTPException(400, { cause: result.error })`. |
| `Bun.cron` | `Bun.cron(pattern, handler)` | Function-pair signature — not `.schedule({...})`, which doesn't exist. |
| `Bun.CryptoHasher` | `new Bun.CryptoHasher("sha256"); hasher.update(str); hasher.digest("hex")` | `update` accepts string/buffer; `digest(encoding)` returns a string for `"hex"`. Used for `requestHash` (§4.2). |
| `Bun.spawn` | `Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" })` → `proc`; `await proc.exited` | `exited` resolves with the exit code; `exitCode` is the sync read. Used by the crash-mid-transaction test to kill a worker between `BEGIN` and `COMMIT`. |
| `Bun.Glob` | `new Bun.Glob(pattern).scanSync({ cwd, absolute: true })` | Iterable of matching paths; `absolute: true` returns absolute paths. Used by the verify-* greps. |
| Hono route pattern | `c.req.routePath` | Returns the registered path pattern (e.g. `/api/invoices/:id/issue`) — the `operation` half of `(operation, key)` (§4.2). |
| Hono error/not-found hooks | `app.onError((err, c) => …)`; `app.notFound((c) => …)` | Mounted in `index.ts`; `lib/errors.ts` maps `HTTPException` status → envelope code, Zod `cause.issues` → `details`, unknown errors → logged `INTERNAL` 500, never leaked. |
| Hono raw body response | `c.body(snapshot, 200, { "content-type": "application/json" })` | Used by `respondIdempotent` so a replayed response is byte-identical to the stored snapshot (§4.2). |
| `Bun.WebView` construction | `new Bun.WebView({ backend: "chrome", headless: true })` | `chrome` backend required for CDP — WebKit has no CDP bridge. |
| `Bun.WebView.cdp` | `await view.cdp("Page.printToPDF", { printBackground: true, format: "A4", preferCSSPageSize: true })` | Result returned **directly** — payload at `result.data`, not `{ data }`. |
| `Bun.S3` | `new Bun.S3Client({ endpoint, accessKeyId, secretAccessKey, bucket })`; `await client.write(path, data, { type })`; `await client.delete(path)`; `client.file(path)` with `await file.exists()` / `await file.arrayBuffer()` | MinIO-compatible via `endpoint` — no separate MinIO SDK. `write` takes bytes + optional `type`; `file()` is lazy — use `exists()`/`arrayBuffer()`. |
| `Bun.Image` thumbnail | `await new Bun.Image(bytes).resize(400, undefined, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).bytes()` | **Resolved 1.3.14 API** — decode is lazy; `resize(w, h?, opts)` not `resize({ width })`, encode is a method chain (`.webp(opts).bytes()`), not `.encode("webp")` (which does not exist on 1.3.x). `bytes()` returns a Promise. One thumbnail per media upload — no image-processing library dependency. |
| `Bun.multipart` filename inference | `new Request(url, { method: "POST", body: formData })` then `await req.formData()` | Bun's multipart parser derives `File.type` from the **filename extension** and ignores the part's declared `Content-Type` (e.g. `x.jpg` with declared `image/png` parses as `image/jpeg`; `x.bin` with declared `image/png` parses as `application/octet-stream`). The media route's MIME gate therefore keys off the extension (`§4.10`). |
| TypeScript 7 CLI | `bunx tsc --noEmit` (native Go binary; `bunx tsc --version` → 7.0.2) | Resolved 2026-08-13 via `bun add -d typescript` → 7.0.2. Checked against the TS 7.0 announcement + bun.com/docs/typescript-6: adopts 6.0 defaults (`types` = `[]`, `strict` on, `rootDir` = `./`, `noUncheckedSideEffectImports` on), hard errors on flags this repo doesn't use (`baseUrl`, `moduleResolution: node/node10/classic`, `target: es5`, `module: amd/umd/systemjs/none`, `esModuleInterop: false`, `alwaysStrict: false`, `assert` on imports). Current tsconfig (all flags kept: `module: "Preserve"`, `moduleResolution: "bundler"`, `allowImportingTsExtensions` + `noEmit`, `verbatimModuleSyntax`, `lib: ["ESNext"]`, `target: "ESNext"`, `esModuleInterop: true`, `types: ["bun"]`) type-checks clean — no flag removal needed. `--checkers`/`--builders`/`--singleThreaded` parallelism knobs exist but are unused (default 4 checkers). **No programmatic API in 7.0** — nothing here imports the `typescript` package; `drizzle-kit` (its own `typescript ^5.6.3` peer) runs unchanged, `db:generate` still reports zero drift. |

Canonical doc URLs for anything not yet in this table: `AGENTS.md` §2.
