# Vitrine — Task (build brief)

Assembled from four prior drafts (A1–A4); see `PROVENANCE.md` for what was
taken from where and why. This is the only document that states **what** and **why**; the
rest state **how**. Read this once, then `architecture.md` → `schema.md` → `api.md`.
`audit.md` is the proof of done. `todo.md` is the execution plan. `AGENTS.md` is the
standing operating protocol for whichever agent is building this — read it before
touching any phase, not just once at the start.

---

## 1. Goal

Build **Vitrine**, a single-tenant retail platform for single/few-outlet Indian retail:
one Bun process, one SQLite file, serving a staff POS + back-office console (catalog,
inventory, purchasing, sales, fulfillment) **and** a customer-facing storefront (browse,
cart, checkout, order tracking), over one HTTP + WebSocket API.

**Scope of these docs: the backend server only.** The staff admin console and the
customer storefront are separate applications that consume this API over
`hc<AppType>()`; they are out of scope here.

## 2. Non-negotiable stack

Binding — do not deviate; install each dependency with `bun add <pkg>` (Bun resolves the
latest compatible version; nothing is hand-pinned) and the verified call shapes are in
`architecture.md` §2 and §6:

**Bun only, everywhere** — one repo, one `bun.lock`, every script `bun run <script>` /
`bunx <tool>`. No Node, no npm, no pnpm, no npx anywhere, in scripts, docs, or CI
(grep-gated) · **`bun:sqlite`**, single file, WAL, single writer · **Drizzle ORM** ·
**Hono** + `hc<AppType>` typed client · **better-auth** (Drizzle adapter) · **Zod** at
the route boundary only · **pino** — zero `console.*`, zero exemptions ·
**TypeScript, strict**, `types: ["bun"]` mandatory · **Bun native WebSockets** — no
Redis, no broker · **PDF = in-process `Bun.WebView`** (chrome backend, CDP
`Page.printToPDF`), printing **client-supplied HTML only** — no backend template, no
external render service, no PDF library · **Media = `Bun.S3` or local disk**, `Bun.Image`
for thumbnails · **Money = INTEGER paise, tax = INTEGER percent** — zero floats in `src/`.

## 3. Architectural commitments (not re-litigated)

1. **Synchronous transactions, compiler-enforced.** Every write runs inside `withTx`,
   whose callback is declared non-async — writing `await` inside it is a TypeScript
   compile error, not a review checklist item. This is what makes every concurrency
   guarantee in this spec provable rather than merely documented. (`architecture.md` §4.1)
2. **Purpose-built fact tables, not one generic ledger.** `stock_movements`, `payments`,
   `order_events`, and `audit_events` each answer one query shape well. No
   event-sourcing engine, no version chains, no correlation/causation graph — those
   buy replay semantics only 1–2 domains actually need, paid on every write everywhere.
   One projection (`stock_levels`), replay-verified. (`architecture.md` §4.6, §4.12)
3. **Exactly-once mutations.** `Idempotency-Key` required on every mutating endpoint;
   idempotency row inserted in the same transaction as the work. Webhooks are the one
   exception: signature-verified before any DB access, deduped on
   `payments UNIQUE(gateway, gatewayEventId)`. (`architecture.md` §4.2)
4. **Never trust the client.** Prices, totals, tax, and stock are recomputed inside the
   deciding transaction every time. The complete list of client-originable values is
   closed and enumerated once. (`architecture.md` §4.4)
5. **Money is INTEGER paise, tax is INTEGER percent.** Zero floats anywhere in `src/`.
6. **RBAC enforced in the service layer**, not just the route — unbypassable from a
   cron job, a webhook, or a future direct caller. Nine capabilities. Protected
   bootstrap admin. (`architecture.md` §4.14)
7. **Publish after commit, structurally.** Realtime publish is an async call; `withTx`
   callbacks can't be async; therefore a publish call literally cannot compile inside a
   transaction. (`architecture.md` §4.8)
8. **Simplicity gate.** Every table, every abstraction must justify itself against §4
   below or be cut. No EAV engine, no double-entry accounting, no versioned API, no
   optimistic locking outside drafts, no queue/broker, no external PDF service. If a
   plan section feels over-modularized, flatten it.

## 4. Scope

**In — every item ships end-to-end:**

1. **Catalog** — categories (tree), products (slugs), variants (SKU/barcode), product
   media (images + WebP thumbnails).
2. **Inventory** — global batches, FIFO allocation, multi-outlet stock, transfers,
   adjustments, one replay-verified projection, never-negative stock post-commit.
3. **Purchasing** — vendor bills (draft → issue), per-line tax, bill charges,
   create-or-reuse batch on issue, vendor payments (partial, capped).
4. **Sales** — POS one-step checkout, manual staff orders, storefront orders; one shared
   `issueInvoice` money/stock core; order tracking timeline (`order_events`).
5. **Payments** — one unified fact table (`direction` in/out) covering received, made,
   and refunded, across cash/UPI/card/bank/gateway; gateway webhooks, signature-verified
   and deduped.
6. **Returns** — sales and purchase, partial, capped against original lines, restock
   mirrors original allocations.
7. **Fulfillment** — shipments per invoice (whole-invoice, no line quantities):
   created → dispatched → delivered.
8. **Parties** — customers (address book), vendors.
9. **Cart & wishlist** — persisted per customer, cross-device; convenience state only,
   never a pricing input — checkout always re-derives.
10. **Org & staff** — settings, outlets, roles (global/outlet-scoped), staff profiles,
    capability RBAC, protected bootstrap admin.
11. **Audit trail** — a lean, flat fact table covering every mutation to catalog, RBAC,
    staff, settings, and media — the compliance question "who changed this, when" is
    always answerable.
12. **Realtime** — WebSocket hub, topic subscriptions, publish-after-commit, refetch-on-
    event client contract.
13. **Invoice PDF** — client-built HTML, server-side print only, non-fatal on failure.
14. **Reliability** — health endpoint that never 500s for a reportable DB issue, rate
    limiting on auth and checkout, nightly backup, nightly stock-replay verification,
    idempotency-key reaper.

**Out — stated once, not relitigated:**

Customer chat/messaging or any communication log · general ledger / double-entry
accounting · stock valuation · GST reconciliation / tax-engine plugins · multi-tenant ·
multi-instance / distributed anything (no Redis, no queues, no brokers — one process is
the architecture) · reservation-at-checkout stock modeling · serial/bin-level tracking ·
fractional unit quantities · versioned API · EAV attribute engines · optimistic
concurrency outside document drafts · exports/imports · reporting beyond paginated list
endpoints · abandoned-cart cleanup.

## 5. Rules of execution

1. One git commit per phase, `phase N: <slug>`, in order — never two phases in one
   commit (`todo.md`).
2. A phase is complete only when its named exit condition (script or test) is green —
   never "looks done."
3. Schema changes update `schema.md` in the same commit; route changes update `api.md`
   in the same commit.
4. `todo.md`'s Session Log is the source of truth for where work stopped — read it
   before starting any phase.
5. Zero `console.*`, zero `any`, zero banned dependencies — grep-gated in `bun run ci`,
   zero exemptions.
6. See `AGENTS.md` for the full standing operating protocol (research-before-coding
   rule, ambiguity handling, commit discipline). It applies to every phase below,
   not just the first one.

## 6. Definition of Done

Exactly `audit.md` §5. In short: all 38 tables per `schema.md` exist with correct
column order, FKs, and indexes; every route in `api.md` is implemented, guarded,
idempotent, and event-publishing per its row (checked bidirectionally); invariants
I1–I11 hold; every named race (`architecture.md` §4.3) has a passing scenario test;
RBAC matrix green; protected admin unkillable; zero `console.*`/`any`/banned deps;
`bun run ci` green from a cold clone; one commit per phase; `todo.md` fully checked;
Session Log ends clean.
