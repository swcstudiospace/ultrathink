# Data Model: PhaseDispatchRecord Provenance (T3b18-data)

Correlation `3b18f741-390c-4422-bdd2-4b18499c4490`. Upstream: `docs/architecture/blueprint-T3b18-arch.md` §4 + `contracts/pstack-dispatch.openapi.json` v1.3.0. A05 implements `outcome.ts`/dispatcher; A06 renders `summaryLine`. A07 defines only the stored shape and its migration; no second resolver, no application code.

## 1. Entities (logical)

| Entity | Role | Keys |
|---|---|---|
| `Phase` (runtime) | One gsd-autonomous phase instance (discuss/plan/execute/review) | `phaseType` (enum), no PK — derived, never stored |
| `PhaseDispatchRecord` (stored) | One provenance row per phase dispatch outcome | `id` PK (uuid), `correlation_id` + `task_id` (trace), `created_at` |
| `DispatchUnit` (embedded) | One wave unit inside a record, stored in `units` (jsonb) | fkey `(record.id, ordinal)`, no PK |

No FK cycles: the only FK is the implicit `DispatchUnit → PhaseDispatchRecord` containment. `FleetOutcome` is runtime-only (A05); only its persisted projection (`state`, `fallback`, `strict`, `reason`, `summaryLine`) is stored. The full `SubagentFleet` payload (skills/paths) is never stored.

## 2. Storage decision

The repo has no SQL driver and no migration runner (persistence is JSON under `.planning/` and the phase-loop store). Therefore:

- Source of truth at runtime: the JSON contract `contracts/pstack-dispatch.data.json` (BACKWARD, additive) + the one-line `summaryLine` in the phase SUMMARY (blueprint §6). A06 consumes `summaryLine`/`PhaseDispatchRecord` from this contract; no new types.
- The SQL pair in `docs/data/migrations/` is **prepared, not executed**: it provisions the same record in A11 ephemeral/shadow databases and any future persistent store, via the repo's migration convention (`*.up.sql` / `*.down.sql`). Execution is an A11 pipeline step at L2 (additive table, no destructive DDL on existing data).

## 3. Expand → migrate → contract

- **Expand** (this migration `2026.11.23-01`): `CREATE TABLE phase_dispatch_records` + index `idx_phase_dispatch_records_phase_created`. New table → no lock on populated tables; `SET lock_timeout = '5s'` matches policy. Writers (A05) emit the new fields; readers tolerate their absence (pre-T3b18 records have no dispatch provenance → read with `state` absent = legacy, never crash).
- **Migrate/backfill**: none — the table is new, zero legacy rows. `data_row_count_reconcile` before/after = 0/0, drift 0.
- **Contract**: nothing to drop (no legacy table/column exists). The contract step is a no-op by design; a future rename would follow expand→backfill→contract, never in-place.

## 4. Rollback plan

Rollback = `DROP TABLE IF EXISTS phase_dispatch_records` (confined to the reverse script). Safe because the table holds only provenance written after the forward; the runtime JSON contract is unaffected. Rehearsal (forward then rollback in an A11 ephemeral DB) is remaining work — `shadow_tested: false` until then.

## 5. Privacy

Zero PII columns: `reason`/`units[].detail` are redacted free text (NFR-19 secret-scan patterns, must hold 0 secrets). Classification coverage 100% (11/11 fields `non-PII`). Retention: provenance rows follow the phase SUMMARY retention; no separate retention change in this task.
