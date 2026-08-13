# Vitrine — Audit & Verification

The proof. Nothing here is optional — `bun run ci` green from a cold
clone is the only acceptable evidence a phase, or the whole system, is done.

---

## 1. Invariants → checker map

Full statements in `schema.md` §17; restated here against what checks each one.

| # | Invariant | Checked by |
|---|---|---|
| I1 | `stock_levels = SUM(stock_movements.delta)` per key; never negative post-commit. | `verify-stock` |
| I2 | Money INTEGER `*Paise` only, no REAL columns, `total ≥ 0` at issue. | `verify-db` + `verify-hygiene` |
| I3 | `[FACT]` insert-only (`stock_movements`, `payments`, `order_events`, `audit_events`). | `verify-db` (triggers exist) + `verify-immutability` (fire) |
| I4 | Totals snapshotted once at issue; client math never read. | scenario tests + `verify-hygiene` client-origin scan |
| I5 | Idempotency: replay identical, zero side effects; mismatch → 409. | scenario tests |
| I6 | Workflow graphs (`architecture.md` §4.7) only; issued documents never edited/voided/re-drafted. | scenario tests |
| I7 | RBAC asserted in the service layer; direct calls cannot bypass. | scenario tests (RBAC matrix) |
| I8 | Every order transition writes ≥1 `order_events` row, same transaction. | `verify-stock` pairing + scenario tests |
| I9 | Webhook dedupe: ≤1 `payments` row per `(gateway, gatewayEventId)`. | scenario tests |
| I10 | Every mutating write to an audited domain writes ≥1 `audit_events` row, same transaction. | `verify-audit` |
| I11 | Cart/wishlist rows generate zero fact events; checkout re-derives every price and stock check regardless of cart contents. | scenario test |

---

## 2. Verify scripts (all deterministic, all in `bun run ci`, in this order)

| Order | Script | What it does | Drift it prevents |
|---|---|---|---|
| 1 | `verify-db.ts` | Asserts the exact table/column/index set matches `schema.md` §3–§13: 38 tables, correct order, FKs, WAL mode, immutability triggers present, **0 CHECK constraints**, **0 REAL columns**. | Schema drift between `schema.md` and the actual migration. |
| 2 | `verify-stock.ts` | Truncates a scratch copy of `stock_levels`, replays every `stock_movements` row in `(createdAt, id)` order, asserts the result is byte-identical to the live projection and that no key is negative. | The one projection silently drifting from the fact table it's derived from — a projection bug surfaces as a failed verify, not a silent oversell. |
| 3 | `verify-immutability.ts` | Fires an `UPDATE`/`DELETE` against each `[FACT]` table in a scratch DB and asserts the trigger raises `ABORT`. Also greps for any direct write to a `[FACT]` table across `lib/`, `db/`, `scripts/`, and `index.ts`; writes must live in `services/` (the owning domain services — there is no `lib/ledger.ts`, layout §4.15). Test files are exempt: scenario suites write fact rows as setup by design. | A migration accidentally dropping or weakening a fact-table trigger; a service bypassing the intended write path. |
| 4 | `verify-routes.ts` | Reads every route row in `api.md` §1–§10 and every route mounted on `app.routes`; asserts the two sets are equal in both directions. | A route implemented but undocumented, or documented but never implemented. |
| 5 | `verify-realtime.ts` | Greps for any `publish` call site inside a `withTx` body (a backstop — the compiler already forbids this, §4.1/§4.8); asserts every `‡`-marked route in `api.md` has a matching publish. | A route shipping without its realtime wiring, or a publish call accidentally reachable inside a transaction. |
| 6 | `verify-audit.ts` | Cross-references every mutating route on an audited domain (`architecture.md` §4.12) against its service function's write path, asserting a matching `audit_events` insert exists. | A new catalog/RBAC/settings/media mutation shipping without its required audit row. |
| 7 | `verify-hygiene.ts` | Scans `lib/`, `db/`, `services/`, `scripts/`, `test/`, `index.ts`, and `drizzle.config.ts` for `console.*`, `any`, and every banned package name (`architecture.md` §2; the scanner's own file is excluded — a linter doesn't flag its own rule definitions); asserts the strict-mode tsconfig flags; runs `bun run typecheck` under `strict: true`; scans route-boundary files (those using `zValidator`/`z.object`) for money fields that are not in the closed client-originable list (`architecture.md` §4.4). | Logging, typing, dependency-boundary, or client-trust discipline eroding silently over time. |
| 8 | `verify-deps.ts` | Scans `lib/`, `db/`, `services/`, `scripts/`, `test/`, and `index.ts` for every import, resolves each bare specifier to a `package.json` dependency, asserts every declared dependency is imported by at least one file (both directions). Exempt from the orphan direction only: tooling invoked via `bunx` (`typescript`, `@types/bun`, `drizzle-kit`) and stack deps whose first import is scheduled for a later phase — currently `@hono/zod-validator` and `zod` (route boundaries, phase 4). The deferred list must be empty or individually justified at sign-off. | An unused ("orphan") dependency, or an import resolving to nothing declared. |

Every check above is deterministic, requires no external service, and runs against a
disposable temp database — nothing in `bun run ci` depends on network access beyond
dependency resolution.

---

## 3. Smoke scripts (happy path + key negatives per domain, all in `bun run ci`)

`smoke-catalog.ts` · `smoke-media.ts` (upload, thumbnail generated, delete, audit row
present, owner-cascade check) · `smoke-inventory.ts` (transfers/adjustments;
re-confirm → 409 zero movements) · `smoke-purchasing.ts` (per-line movements,
batch create-or-reuse, re-issue 409 zero rows) · `smoke-sales.ts` (POS one-step:
order+invoice+movements in one tx; draft quote zero movements; double-issue 409 zero
rows; client prices overridden, custom lines honored) · `smoke-storefront.ts` (cart
persists across sessions; checkout re-prices even against a stale cart; cart clears
only on success; own-orders isolation) · `smoke-payments.ts` (partial caps, refund
caps, bad/missing signature → 401 zero rows, dedupe replay → 200 zero rows) ·
`smoke-returns.ts` (over-return 409 zero movements; confirm mirrors exact batches;
refund cap math) · `smoke-fulfillment.ts` · `smoke-ops.ts` (health never 500s;
rate limits trip; backup/verify-stock crons are non-fatal on failure).

---

## 4. Scenario suite (`bun test`) — integration + race/crash semantics

All races R1–R9 (`architecture.md` §4.3), each with a dedicated test spinning up two
concurrent callers against a shared temp DB and asserting exactly one succeeds:

- **R1** — same idempotency key fired twice concurrently → single execution, replay
  byte-identical.
- **R2** — last-unit checkout race → exactly one `200` + one `409`, final quantity 0
  (never −1, never 1).
- **R3** — payment over balance → `409 over_payment`, no partial row survives.
- **R4** — over-return → `409 over_return`, zero new movements.
- **R5** — concurrent draft edits → `409 stale_version`, 0 rows changed.
- **R6** — duplicate batch number → `409 duplicate_batch`.
- **R7** — webhook replay/race → `200` on the duplicate, zero side effects.
- **R8** — concurrent sales from the same batch, different outlets → each store's gate
  re-derives its own sum correctly.
- **R9** — concurrent catalog/role edits under audit → both writes serialize cleanly,
  both produce correct `audit_events` rows.

**Crash-mid-transaction test** — kills the process (or simulates a thrown error)
between `BEGIN` and the final `COMMIT` of an idempotent operation, restarts against the
same DB file, and replays the same key: asserts no partial row exists and the retried
call executes cleanly exactly once.

**Workflow/correction tests** — every status graph in `architecture.md` §4.7: issued
documents reject re-issue and edit attempts (`409`); void is rejected on non-draft
documents; corrections via counter-document (return, reverse transfer, refund) produce
correct fact rows without touching the original.

**Webhook integrity** — bad/missing signature → `401`, zero DB access; valid signature
+ new event → processes once; valid signature + seen event → `200`, zero side effects.

**RBAC matrix** — every capability × every gated route, tested both allowed and
denied; a direct service call without the capability is rejected the same as a route
call; protected bootstrap admin: delete/deactivate → `409` from every angle.

**Realtime** — live publish observed for every `‡` route; a rollback publishes
nothing (compile-time guarantee, backstopped by `verify-realtime`).

**Rate limiting** — auth and checkout trip `429 RATE_LIMITED` at their configured
thresholds.

**PDF resilience** — Chrome missing / navigate failing / print failing: the parent
invoice-issue or render-pdf call still succeeds/returns, `pdfPath` stays null, a
`warn`-level log is emitted.

**Money/client-origin checks** — every mutating route's Zod body schema is scanned to
confirm no non-enumerated money/total field exists on it (`architecture.md` §4.4's
closed list is the only client-originable set).

**I11 cart integrity** — a manipulated or stale cart never survives checkout's
re-pricing and re-gating pass.

---

## 5. Definition of Done (final sign-off)

38 tables per `schema.md`, correct order/FKs/indexes — green (`verify-db`). Every
route in `api.md` mounted and no others — green (`verify-routes`). All invariants
I1–I11 hold on a fresh DB. RBAC matrix green; protected admin unkillable; fresh boot →
exactly one `isProtected` profile. Money guards green (`verify-hygiene`). Audit
coverage green (`verify-audit`). Realtime wiring green (`verify-realtime`). Dependency
hygiene green (`verify-deps`). `bun run ci` green on a cold clone — **the only
acceptable proof of done**. One commit per phase, in order, none bundling two phases.
`todo.md` fully checked; Session Log ends clean; `schema.md`/`api.md` current with the
code in the same commit as every change that touched them.

---

## 6. Ops verification (backup/restore)

**Restore procedure** (exercised at least once before the audit sign-off):

1. Stop the process.
2. Copy the desired timestamped backup file (and its `-wal`/`-shm` companions if
   present) over `DATABASE_PATH`.
3. Start the process — Bun opens the file and runs WAL recovery automatically on
   connect if a `-wal` file is present.
4. Run `bun run scripts/verify-stock.ts` manually against the restored file before
   resuming traffic, to confirm the projection is consistent with the restored fact
   tables.

**Monitoring/alerting hooks:**

- `GET /api/health` returns `200` under normal operation and is designed to **never**
  return `500` for a reportable database condition — a degraded-but-queryable DB
  reports `status: "degraded"` in the body at `200`, so uptime monitors alert on body
  content, not just status code.
- The nightly `verify-stock` cron logs at `fatal` level (with the specific mismatched
  key) on any projection drift, without crashing the process — this is the signal to
  page on.
- The nightly backup job logs at `error` level on failure — a second, independent
  alerting signal.
- `pino` output is structured JSON to stdout; the deployment environment ships it to a
  log aggregator and alerts on `level >= error`.
