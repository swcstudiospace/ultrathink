# Data Model: UpliftDeliveryRecord Ledger (Tdfe6-data)

Correlation `dfe6b075-b574-47af-9556-0c7845221d85`. Upstream: `docs/architecture/blueprint-Tdfe6-arch.md` §4–§6 + `contracts/swarm-uplift-race.openapi.json` v1.0.0 (`POST /force-inject`, `POST /order-gate`, `POST /drain`, `GET /delivery-status`). A05 implements force-injection, the order gate and the drain coordinator; A06 renders injection/drain notices. A07 defines only the stored shape and its migration; no application code, no second store.

## 1. Entities (logical)

| Entity | Role | Keys |
|---|---|---|
| `ForceInjectAttempt` (runtime) | One delivery attempt of the full uplifted prompt to the session chat | `sessionId` + attempt ordinal, no PK — derived ledger row, never stored standalone |
| `OrderGateDecision` (runtime) | One dispatch-gate verdict for a prompt (allowed or refused with 1 held reason) | `sessionId` + decision ordinal, no PK — derived ledger row |
| `DrainOutcome` (runtime) | One bounded-drain result for a new prompt (drained or timed-out within 30s) | `sessionId` + drain ordinal, no PK — derived ledger row |
| `UpliftDeliveryRecord` (stored) | One status-ledger row per delivery outcome (force-inject, order-gate or drain) via the `record_type` discriminator | `id` PK (uuid), `session_id`, `correlation_id` + `task_id` (trace), `created_at` |
| Todo update (side effect) | TODO list update on injection (`todo_updated=true` when landed) | part of the injected record, no PK |

No FK cycles: there are no FKs at all — the ledger is a single append-only table with no references to other tables, so no FK cycle check applies. Full session chat and swarm task payloads are never stored; only the redacted prompt projection plus ledger metadata.

## 2. Storage decision

The repo has no SQL driver and no migration runner (persistence is session files under `.planning/`/session files and the tracker gateway). Therefore:

- Source of truth at runtime: the session files plus the JSON contract `contracts/swarm-uplift-race.data.json` (BACKWARD, additive v1.0.0) + the OpenAPI contract `contracts/swarm-uplift-race.openapi.json` 1.0.0. A05/A06 consume `UpliftDeliveryRecord` from those contracts; no new types.
- The SQL pair in `docs/data/migrations/` is **prepared, not executed**: it provisions the same ledger in A11 ephemeral/shadow databases and any future persistent store, via the repo's migration convention (`*.up.sql` / `*.down.sql`). Execution is an A11 pipeline step at L2 (additive table, no destructive DDL on existing data).

## 3. Expand → migrate → contract

- **Expand** (this migration `2026112303`): `CREATE TABLE uplift_delivery_records` + index `idx_uplift_delivery_records_session_created`. New table → no lock on populated tables; `SET lock_timeout = '5s'` matches policy. Writers (A05) emit the new fields; readers tolerate their absence (pre-Tdfe6 sessions have no delivery ledger → `state` absent = legacy, never crash). `prompt_hash` is the sha256 hex of the stored `prompt_text` so a retry reuses the byte-identical prompt (0 prompt loss, FR-1) instead of re-uplifting. `injection_latency_ms <= 5000` is enforced for `state = 'injected'` by a table `CHECK`, so a stored injected row is proof of NFR-28 compliance, not a claim. `retry_budget` is finite (default 3) and `reason` is required content on `dropped-with-reason`, so no delivery can end without a named reason (FR-2). `drain_bound_s <= 30` encodes the 30-second bound (FR-3, A2 may tighten, never remove); drain rows are terminal (`drained` / `timed-out`) and single-statement inserts are atomic, so 0 mid-write kills can be rehearsed. `held_reason` carries exactly 1 plain-text en-US reason per refused gate row and `allowed` flips to `true` only once the injection confirmation exists, so "0 dispatch before confirmation" is decided by reading the ledger, not by timing (FR-4). For order-gate rows `state = 'injected'` means the gate is open (confirmation present) and `state = 'retrying'` means the gate is holding.
- **Migrate/backfill**: none — the table is new, zero legacy rows. `data_row_count_reconcile` before/after = 0/0, drift 0.
- **Contract**: nothing to drop (no legacy table/column exists). The contract step is a no-op by design; a future rename would follow expand→backfill→contract, never in-place.

## 4. Rollback plan

Rollback = `DROP TABLE IF EXISTS uplift_delivery_records` (confined to the reverse script). Safe because the table holds only ledger rows written after the forward; the runtime session files and JSON contract are unaffected. Rehearsal (forward then rollback in an A11 ephemeral DB) is remaining work — `shadow_tested: false` until then.

## 5. Privacy

Zero PII columns: `prompt_text` is redacted uplifted-prompt text (NFR-29 secret-scan patterns in `src/redact.ts`, must hold 0 secrets; treated as untrusted session data, never instructions); `held_reason`/`reason` are short en-US plain-text audit words, secret-scanned before persistence; `session_id`/`correlation_id` are internal ids. Classification coverage 100% (20/20 fields `non-PII`, redacted where free text). Retention: ledger rows follow the session-file retention; `prompt_text` is kept verbatim on retry (0 prompt loss) and no separate retention change happens in this task.
