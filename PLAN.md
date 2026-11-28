# Wave Execution Plan — Waves 1–2 (phase-loop hardening + plan density)

Ref: SPE-39908 — https://linear.app/swcstudio/issue/SPE-39908/n7-synthesize-wave-execution-plan

## Goal

Land the Wave 1–2 phase-loop hardening and plan-density work as a coherent,
reversible change set: durable phase-loop persistence with compare-and-swap
wiring, transition observability (telemetry, repair audit, cleanup
authorization), lifecycle status shape, HTIL governance (SLA escalation,
resolution provenance), and plan-check/think hardening (`BLOAT_LIMIT` export
with historic alias, decision-observer hook, prompt/type updates) — each wave
independently committable and independently revertable.

## Entry criteria

- Base is a clean tree at or after `05bd6d3` (ADR renumber) with no unrelated
  staged work in the nine Wave 1–2 files.
- Wave 1 scope is the eight committed units `ae91119`..`f1ef6ca`
  (persistence/wiring, CAS/validation/lifecycle, observability/cleanup,
  P2 status shape, FSM telemetry/repair audit, P3 telemetry contracts, HTIL
  SLA/provenance, HTIL regression cover).
- Wave 2 scope is the working-tree delta across the nine files named in
  Acceptance (`scripts/plan-check*`, `src/think/prompts*`, `src/think/types*`,
  `src/workflow/phase-loop*`, `src/workflow/phase-loop-store*`).
- No live deployment, migration run, or credential rotation is in flight;
  this plan touches code and tests only.

## Implementation steps

### Wave 1 (committed: `ae91119`..`f1ef6ca`)

1. Phase-loop persistence and wiring (`ae91119`): durable store, writer
   wiring, lifecycle plumbing in `src/workflow/phase-loop*.ts`,
   `src/host/omp-phase*.ts`, `src/ship/cli*.ts`.
2. CAS, validation, lifecycle status cover (`840e8a3`): characterization
   snapshots plus store/loop unit cover for CAS paths and status shape.
3. Transition observability and cleanup authorization (`ba27b69`):
   observable transitions, authorized cleanup paths in loop, store, omp host.
4. P2 lifecycle status shape (`6fb8c90`): status surface in `cli.ts` /
   `phase-loop.ts` with snapshot pin.
5. Durable FSM transition telemetry and repair audit (`66986f6`): persisted
   transition records, repair audit trail, CLI/store/host seams.
6. P3 transition telemetry contracts (`2606e7c`): contract tests pinning the
   P3 telemetry shape before governance lands on top.
7. HTIL SLA escalation and resolution provenance (`589111c`): escalation
   paths, provenance records, omp-phase and CLI seams.
8. HTIL governance regression cover (`f1ef6ca`): regression tests locking
   the Wave 1 governance behavior.

### Wave 2 (working tree, uncommitted)

9. `scripts/plan-check.ts`: hoist regex/pattern constants, export
   `BLOAT_LIMIT` (520) with `BLOAT_LINE_LIMIT` historic alias, add the
   side-effect-free `PlanCheckOptions.onDecision` observer hook; keep the
   default call path silent.
10. `src/think/types.ts` + `src/think/prompts.ts`: type and prompt updates
    backing the density work, with `prompts.test.ts` cover.
11. `src/workflow/phase-loop-store.ts` + `src/workflow/phase-loop.ts`:
    store/loop hardening deltas with extended `phase-loop-store.test.ts`
    and `phase-loop.test.ts` cover.
12. `scripts/plan-check.test.ts`: bloat-limit and gate-behavior pins for the
    Wave 2 contract changes.
13. Keep the change set additive and boring: no new patterns, no second
    convention, no shims; migrate every caller of renamed exports.

## Verification steps

1. Scope check: `git status --short` and `git diff HEAD --stat` show only
   the nine listed files (plus PLAN.md/SUMMARY.md/ROADMAP.md/STATE.md docs).
2. Marker scan: `git diff` over changed lines contains no leftover task markers.
3. Targeted suites for the touched areas only (per delegation rules, the main
   agent runs these once all subagents land — not run inside this wave):
   `scripts/plan-check.test.ts`, `src/think/prompts.test.ts`,
   `src/workflow/phase-loop-store.test.ts`, `src/workflow/phase-loop.test.ts`,
   plus the omp-phase/ship CLI suites touched by Wave 1.
4. Type and lint surface for the touched files only (main-agent run).
5. History check: existing commits and `.planning` history preserved;
   ROADMAP/STATE updates are append-only.

## Exit criteria

- PLAN.md and SUMMARY.md exist with all required sections.
- `.planning/ROADMAP.md` progress and `.planning/STATE.md` reflect Wave 1–2
  completion, append-only, prior entries untouched.
- `git diff` on changed lines shows no leftover task markers.
- Files changed are reported; gates/formatters skipped by assignment.

## Rollback notes for Wave 1–2 work

- Wave 2 (uncommitted): `git checkout -- <file>` per file, or
  `git stash push` the nine files; docs-only files revert the same way.
  No migration or data change is involved, so revert is loss-free.
- Wave 1 (committed `ae91119`..`f1ef6ca`): `git revert` in reverse order
  (`f1ef6ca` first, `ae91119` last); each unit is a self-contained
  feat/test pair, so reverting a single unit does not require reverting
  the others except where tests pin behavior added by an earlier unit —
  revert the paired test commit together in that case.
- Store/loop changes are file-local and backward compatible; no persisted
  format migration ships in this plan, so rollback needs no backfill.
- If already pushed, prefer `git revert` over history rewrite; never rewrite
  commits other agents or the user have built on.
