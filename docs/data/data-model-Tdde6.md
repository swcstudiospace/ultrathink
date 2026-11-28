# Data Model: DoubleUpliftRecord Provenance (Tdde6-data)

Correlation `dde6accb-e288-424f-8913-cb429e5f88ef`. Upstream: `docs/architecture/blueprint-Tdde6-arch.md` §4–§6 + `contracts/ultrathink-double-uplift.openapi.json` v1.0.0 (DoubleGraph/StageMetrics/FinalPrompt/DispatchGate). A05 implements the pipeline stages; A06 renders the full-prompt-beneath section. A07 defines only the stored shape and its migration; no application code, no second store.

## 1. Entities (logical)

| Entity | Role | Keys |
|---|---|---|
| `DoubleGraph` (runtime) | GoT graph + per-node CoT (5–8 nodes, 5–8 steps each) + both uplift passes | `graphId`, no PK — derived, never stored standalone |
| `DoubleUpliftRecord` (stored) | One provenance row per session double-uplift run: accounting, per-stage metrics, final-prompt bar, dispatch gate | `id` PK (uuid), `session_id` + `graph_id`, `correlation_id` + `task_id` (trace), `created_at` |
| `StageMetric` (embedded) | One stage line count inside a record, stored in `stage_metrics` (jsonb) | fkey `(record.id, ordinal)`, no PK |
| `FinalPrompt` (embedded projection) | `final_prompt_xml` + `line_count` + `linked_issues` + `truncation_markers` (jsonb for issues) | part of the record row, no PK |

No FK cycles: there are no FKs at all — `StageMetric`/`linked_issues` are containment, not references. The full tracker payload (Linear/Notion rows) is never stored; only gateway-returned references in `linked_issues`.

## 2. Storage decision

The repo has no SQL driver and no migration runner (persistence is session XML under `.planning/`/session files and the tracker gateway). Therefore:

- Source of truth at runtime: the session XML + the JSON contract `contracts/ultrathink-double-uplift.data.json` (BACKWARD, additive v1.0.0) + the OpenAPI contract `contracts/ultrathink-double-uplift.openapi.json` 1.0.0. A05/A06 consume `FinalPrompt`/`StageMetrics` from those contracts; no new types.
- The SQL pair in `docs/data/migrations/` is **prepared, not executed**: it provisions the same record in A11 ephemeral/shadow databases and any future persistent store, via the repo's migration convention (`*.up.sql` / `*.down.sql`). Execution is an A11 pipeline step at L2 (additive table, no destructive DDL on existing data).

## 3. Expand → migrate → contract

- **Expand** (this migration `2026112302`, RF-011 rework loop1): `CREATE TABLE double_uplift_records` + index `idx_double_uplift_records_session_created`. New table → no lock on populated tables; `SET lock_timeout = '5s'` matches policy. Writers (A05) emit the new fields; readers tolerate their absence (pre-Tdde6 sessions have no double-uplift provenance → `final_prompt_landed` absent = legacy, never crash). Contract conformance (RF-011): `prompts_total = 3 + node_count` (1 graph + N node chains + 2 uplifts; the contract `promptsTotal const 10` is the N=7 default, 3+7=10, and is a subset — no contract-valid row is rejected, non-default N is no longer rejected); `line_count` is measured with `CHECK (line_count >= 0 AND (final_prompt_landed = false OR line_count >= 500))` so a landed record must satisfy the contract `lineCount minimum 500` (AC-55) while an unlanded/provisional row may be 0 — the DB enforces, never fabricates, the 500-line claim (FR-7).
- **Migrate/backfill**: none — the table is new, zero legacy rows. `data_row_count_reconcile` before/after = 0/0, drift 0.
- **Contract**: nothing to drop (no legacy table/column exists). The contract step is a no-op by design; a future rename would follow expand→backfill→contract, never in-place.

## 4. Rollback plan

Rollback = `DROP TABLE IF EXISTS double_uplift_records` (confined to the reverse script). Safe because the table holds only provenance written after the forward; the runtime session XML and JSON contract are unaffected. Rehearsal (forward then rollback in an A11 ephemeral DB) is remaining work — `shadow_tested: false` until then.

## 5. Privacy

Zero PII columns: `final_prompt_xml`/`prompt_accounting` are redacted prompt text (secret-scan patterns in `src/redact.ts`, must hold 0 secrets); `linked_issues` are tracker references (Linear/Notion ids), not personal data. Classification coverage 100% (19/19 fields `non-PII`, redacted where free text). Retention: provenance rows follow the session XML retention; no separate retention change in this task.
