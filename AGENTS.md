# AGENTS.md — Standing Operating Protocol

This applies to **every phase** in `todo.md`, not just the first one.
Re-read it whenever you're unsure whether a shortcut is safe — it usually isn't.

---

## 1. Before every phase, before every commit

1. Re-read `todo.md`'s Session Log, then the phase you're about to start, then the
   relevant section(s) of `architecture.md` / `schema.md` / `api.md` it depends on.
   Don't work from memory of a doc you read three phases ago — it may have changed
   (§4).
2. Do the work.
3. Run the phase's exit condition (script or test) yourself — a phase is done when
   its named check is green, never because it "looks done."
4. If the phase touched the schema, update `schema.md` in the **same commit**. If it
   touched a route, update `api.md` in the **same commit**. Docs and code drift
   together or not at all.
5. Append one row to `todo.md`'s Session Log: date, phase, what passed, what (if
   anything) changed in the docs.
6. One git commit, `phase N: <slug>`, covering exactly that phase — never two phases
   bundled into one commit, never a phase split across two commits. The commit is your
   code, the doc updates, and the Session Log row only.

## 2. Standing research rule — never code an unfamiliar call from memory

Before writing any call to a library API you are not **100% certain** of against the
version `bun add <pkg>` resolved and recorded in `architecture.md` §2, search the
canonical documentation
first. This is not a one-time step — it applies every time you touch an API surface
you haven't already verified in `architecture.md` §6 (Verified Library Calls).

Canonical doc sources, in priority order: (1) the package's own README/docs site for
the resolved major version, (2) its TypeScript type definitions (`node_modules/<pkg>`),
(3) its changelog/release notes if the resolved version is recent. Never trust a
remembered API shape from an older or newer version of the same library — check the
version actually installed in `node_modules`.

If you verify a call shape that isn't already in `architecture.md` §6, **add a row to
that table in the same commit** — the table is the running record of what's been
checked, so the next phase (or the next agent) doesn't have to re-verify it.

Known traps already checked, do not re-litigate: `bun:sqlite` has no `.sync()`
variant; `zValidator` does not throw by default on failure; `better-auth`'s adapter
uses its own documented column names, never remap them; Zod v4 uses `z.enum`, not
`z.nativeEnum`, and issues live at `error.issues`; `Bun.cron(pattern, handler)`, not
`.schedule({...})`; `Bun.WebView.cdp()` returns its result directly, not nested under
`{ data }`. Full table: `architecture.md` §6.

## 3. Three invariants that never bend

These are structural commitments from `architecture.md` §1/§4.1, restated here as a
standing rule because they are the ones most likely to look like reasonable
shortcuts under time pressure. They are not:

1. **Every write goes through `withTx`, and the callback is never `async`.** If you
   find yourself wanting to `await` something inside a transaction body — a publish
   call, a PDF render, an external fetch — that is a signal the operation belongs
   *outside* the transaction, not a reason to make the callback async. Move it.
2. **Realtime publish only happens after commit, from the route handler, never from
   inside a service function or a transaction body.** A service function returns
   facts to publish; it never calls `realtime.publish` itself.
3. **Zero hygiene exemptions.** No `console.*`, no `any`, no banned dependency
   (`architecture.md` §2), no CHECK constraint, no REAL money column — not "just this
   once," not "just in a test file," not "just to unblock CI temporarily." If a
   hygiene rule is genuinely wrong for a case you've hit, that's a spec bug — fix the
   rule in the doc, don't route around it in code.

## 4. Ambiguity in the spec is a spec bug

If `architecture.md`, `schema.md`, or `api.md` is ambiguous, silent, or contradicts
itself on something you need to decide to proceed: that is a defect in the
specification, not a decision for you to make silently and move on from. Fix the
doc — add the missing rule, resolve the contradiction — **in the same commit** as the
code that needed the answer, and note it in the Session Log entry for that phase. Do
not improvise a convention that isn't written down anywhere; the next phase (or the
next agent) has no way to discover an unwritten decision.

## 5. Never trust the client, restated as a habit

Every time you write a mutating route, ask: which of these fields could the caller
lie about, and does my service function recompute it from source rather than
trusting the payload? `architecture.md` §4.4 is the closed list of what's genuinely
client-originable. Anything touching money, tax, stock, or a balance/cap that isn't
on that list must be recomputed inside the deciding transaction, every time, even if
it feels redundant on the happy path — the whole race-safety story (`architecture.md`
§4.3) depends on this being universal, not case-by-case.

## 6. When you're not sure a design decision is still correct

Prefer the simplest mechanism that satisfies `task.md` §3's commitments over a more
general one, even if the general one feels more "proper." If you're about to add a
new table, a new abstraction layer, or a new external dependency, check it against
`task.md` §4 (scope) and `architecture.md` §5 (explicit non-goals) first — if it's on
either list, it doesn't ship, no exceptions without a documented change to those
sections.

## 7. Session Log discipline

`todo.md`'s Session Log is the single source of truth for "where did work stop."
Read it before starting anything. If you are resuming after a gap (a new session, a
different agent, a long pause), do not assume the last commit's phase is fully done —
re-run that phase's exit condition yourself before starting the next one. A green
exit check from a prior session is not proof it's still green after any dependency
bump or doc fix that happened since.

## 8. Context compaction and long-session handoffs

Git commits and the Session Log survive a context reset — anything **inside** a phase
that hasn't been committed yet does not. A compaction summary is not a reliable
record of exactly which sub-step you were on, which file you'd half-edited, or what
open question you were mid-way through resolving. Do not rely on it for that. Treat
an impending compaction (yours, or one you're told is about to happen) as a forced
handoff to a version of yourself with no memory of this session, and checkpoint
accordingly, using `HANDOFF.md` at the repo root:

1. **Do not fabricate a phase commit to "save progress."** A commit only happens when
   that phase's named exit condition is green (§1, §3). If the phase is incomplete,
   it stays uncommitted — the checkpoint goes in `HANDOFF.md`, not in a premature git
   commit.
2. Bring whatever you're mid-edit on to a safe stopping point if you can — finish the
   file or function you're inside of rather than leaving it half-written, even if the
   phase as a whole isn't done.
3. Overwrite `HANDOFF.md` with exactly this, no more, no less:
   ```
   ## Handoff — <ISO date/time>
   Phase: <N — slug, from todo.md>
   Sub-step: <precisely what's done vs. not, inside this phase's checklist>
   Files touched, uncommitted: <paths>
   Open question / spec ambiguity found but not yet resolved: <or "none">
   Exact next action: <the single next thing to do — not a summary of the phase>
   ```
   This file is a checkpoint, not history — it always describes only the *current*
   in-flight state and gets overwritten every time, never appended to. History lives
   in git log + the Session Log (§7), one row per *completed* phase, never a partial
   one.
4. After a reset, before doing anything else: check whether `HANDOFF.md` exists and
   is non-empty. If it is, treat it as the first thing to verify, not the first thing
   to trust — read it, then check the actual state of the files it names and the
   phase's checklist in `todo.md` against what it claims. The note tells you where to
   look; the repo tells you what's actually true. If they disagree, the repo wins.
5. Once the phase `HANDOFF.md` describes reaches a real commit, clear the file back
   to empty (or delete it) in that same commit. An absent or empty `HANDOFF.md` is
   itself meaningful — it signals nothing is in flight, everything is captured in git
   + the Session Log.
6. This is independent of, and in addition to, the resume protocol in §7 — run both:
   `HANDOFF.md` first (mid-phase state, if any), then the git-log/exit-condition
   re-verification (last *completed* phase, always).
